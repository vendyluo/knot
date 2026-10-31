import { createRemoteJWKSet, jwtVerify } from "jose";
import { consolePage, type ConsoleModel, type ConsoleReminder } from "./console-page";
import { getReminderControl, setReminderPaused } from "./reminder-control";
import { cancelReminder } from "./reminders";
import type { Env } from "./types";

async function isOwner(request: Request, env: Env): Promise<boolean> {
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.CONSOLE_TEAM_DOMAIN ?? "") ||
    !env.CONSOLE_AUD || !env.CONSOLE_OWNER_EMAIL) return false;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  try {
    const keys = createRemoteJWKSet(new URL(`${env.CONSOLE_TEAM_DOMAIN}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.CONSOLE_TEAM_DOMAIN, audience: env.CONSOLE_AUD, algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "email"],
    });
    return typeof payload.email === "string" && payload.email.toLowerCase() === env.CONSOLE_OWNER_EMAIL.toLowerCase();
  } catch {
    return false;
  }
}

function page(model: ConsoleModel | null, error = "", status = 200): Response {
  const nonce = crypto.randomUUID();
  return new Response(consolePage(model, error, nonce), { status, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    // no-referrer makes native form POSTs send Origin:null in Chromium.
    "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  } });
}

export async function handleConsole(request: Request, env: Env): Promise<Response> {
  // Validate on every route, including direct workers.dev requests. No cookie/header-presence shortcut.
  if (!(await isOwner(request, env))) return page(null, "無法驗證部署者身分。請從已設定 Cloudflare Access 的控制台網址登入；管理者需確認 Access 與 console 設定。", 403);
  const url = new URL(request.url);
  let error = "";
  let status = 200;
  try {
    if (request.method === "POST") {
      if (request.headers.get("origin") !== url.origin ||
        request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
        return page(null, "操作來源無效。請重新開啟控制台。", 403);
      }
      // Both forms contain only short numeric fields. Read at most 1 KiB, including chunked bodies.
      const reader = request.body?.getReader();
      let body = "";
      let size = 0;
      const decoder = new TextDecoder();
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024) { await reader.cancel(); return page(null, "操作資料過長。", 413); }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      }
      const form = new URLSearchParams(body);
      if (url.pathname === "/console/pause") {
        const revision = form.get("revision") ?? "";
        const paused = form.get("paused");
        if (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || !["0", "1"].includes(paused ?? "")) {
          return page(null, "操作資料無效。", 400);
        }
        if (paused === "0" && env.NOTIFY_ENABLED !== "true") {
          error = "部署設定尚未啟用提醒。控制台不能越過 NOTIFY_ENABLED；請先由部署者確認額度及設定。";
          status = 409;
        } else if (!(await setReminderPaused(env.DB, paused === "1", Number(revision)))) {
          error = "設定已由另一個頁面更新，這次操作未套用。請核對下方最新狀態再操作。";
          status = 409;
        }
      } else if (url.pathname === "/console/cancel") {
        const id = Number(form.get("id"));
        if (!Number.isSafeInteger(id) || id <= 0) return page(null, "提醒編號無效。", 400);
        const row = await env.DB.prepare("SELECT workspace_key FROM reminders WHERE id = ?").bind(id).first<{ workspace_key: string }>();
        const reminder = row ? await cancelReminder(env.DB, row.workspace_key, id, Math.floor(Date.now() / 1000)) : null;
        if (reminder?.status !== "cancelled") {
          error = reminder ? `提醒 #${id} 已非待發狀態，未取消。已開始的發送可能完成。` : `找不到提醒 #${id}，可能已清理。`;
          status = 409;
        }
      } else return page(null, "找不到這個操作。", 404);
      if (!error) return new Response(null, { status: 303, headers: { Location: "/console", "Cache-Control": "no-store" } });
    } else if (request.method !== "GET" || !["/console", "/console/"].includes(url.pathname)) {
      return page(null, "找不到這個頁面。", 404);
    }

    const filter = url.searchParams.get("filter") ?? "all";
    const offset = Number(url.searchParams.get("page") ?? "0");
    if (!["all", "active", "issues"].includes(filter) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) {
      return page(null, "篩選或頁碼無效。請回控制台重新選擇。", 400);
    }
    const where = filter === "active" ? "WHERE status IN ('pending', 'sending')" :
      filter === "issues" ? "WHERE status IN ('failed', 'expired', 'unknown')" : "";
    // Deliberate projection: no task, identifiers, retry keys or payload in the page, even hidden.
    const rows = await env.DB.prepare(`SELECT id, CASE WHEN workspace_key LIKE 'user:%' THEN '私人' ELSE '群組' END AS location,
      due_at, status, attempts, last_error FROM reminders ${where} ORDER BY id DESC LIMIT 21 OFFSET ?`)
      .bind(offset * 20).all<ConsoleReminder>();
    const control = await getReminderControl(env.DB);
    return page({ control, enabled: env.NOTIFY_ENABLED === "true", parser: env.NOTIFY_TIME_PARSER === "ai" ? "ai" : "rule",
      reminders: rows.results.slice(0, 20), hasMore: rows.results.length > 20, filter, page: offset, now: Math.floor(Date.now() / 1000) }, error, status);
  } catch {
    console.error(JSON.stringify({ event: "console_storage_error" }));
    return page(null, "目前無法確認狀態，請勿假設操作成功。重新整理後核對；若持續失敗，檢查 D1 與 0004 migration。", 503);
  }
}

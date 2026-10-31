import { readFile } from "node:fs/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleConsole } from "../src/console";
import { getReminderControl } from "../src/reminder-control";
import { consolePage, type ConsoleModel } from "../src/console-page";
import type { Env } from "../src/types";

let mf: Miniflare;
let env: Env;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let token: string;
let jwks: object;
const origin = "https://knot.example";
const issuer = "https://synthetic.cloudflareaccess.com";
async function sign(overrides: Record<string, unknown> = {}, privateKey = keys.privateKey): Promise<string> {
  return new SignJWT({ email: "owner@example.com", sub: "synthetic-owner", iss: issuer, aud: "console-audience",
    exp: Math.floor(Date.now() / 1000) + 3600, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(privateKey);
}
function request(path = "/console", body?: string, auth = token): Request {
  return new Request(origin + path, { method: body === undefined ? "GET" : "POST", body,
    headers: { "cf-access-jwt-assertion": auth, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } });
}
beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-09-11", d1Databases: ["DB"], r2Buckets: ["BUCKET"] }));
  env = { ...await mf.getBindings<Pick<Env, "DB" | "BUCKET">>(), LINE_CHANNEL_SECRET: "synthetic", LINE_CHANNEL_ACCESS_TOKEN: "synthetic",
    NOTIFY_ENABLED: "true", NOTIFY_TIME_PARSER: "rule", CONSOLE_TEAM_DOMAIN: issuer, CONSOLE_AUD: "console-audience", CONSOLE_OWNER_EMAIL: "owner@example.com" };
  for (const name of ["0003_reminders.sql", "0004_reminder_control.sql"]) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await env.DB.batch(sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
  }
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = { keys: [{ ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" }] };
  token = await sign();
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  env.NOTIFY_ENABLED = "true";
  await env.DB.exec("DELETE FROM reminders");
  await env.DB.exec("UPDATE reminder_control SET paused = 0, revision = 0");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(String(url)).toBe(`${issuer}/cdn-cgi/access/certs`);
    return Response.json(jwks);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function seed(id: number, status = "pending", error: string | null = null): Promise<void> {
  await env.DB.prepare(`INSERT INTO reminders (id, workspace_key, source_message_id, destination, text, due_at, created_at, retry_key, status, last_error)
    VALUES (?, 'group:PRIVATE-ID', ?, 'PRIVATE-DESTINATION', 'PRIVATE-TASK', 1789277400, 1789191000, ?, ?, ?)`)
    .bind(id, `PRIVATE-MESSAGE-${id}`, `PRIVATE-RETRY-${id}`, status, error).run();
}

describe("owner console auth and controls on local D1", () => {
  it("rejects unconfigured, missing, forged and invalid identity tokens before DB reads", async () => {
    const db = new Proxy(env.DB, { get() { throw new Error("must not access DB"); } });
    for (const auth of ["", "fake", await sign({ email: "other@example.com" }), await sign({ aud: "other-app" }),
      await sign({ iss: "https://other.cloudflareaccess.com" }), await sign({ exp: 1 }),
      await sign({}, (await generateKeyPair("RS256")).privateKey)]) {
      expect((await handleConsole(request("/console", undefined, auth), { ...env, DB: db })).status).toBe(403);
      expect((await handleConsole(request("/console/pause", "paused=1&revision=0", auth), { ...env, DB: db })).status).toBe(403);
    }
    expect((await handleConsole(request(), { ...env, DB: db, CONSOLE_AUD: "" })).status).toBe(403);
  });

  it("renders only safe metadata and rejects unknown filters without echoing them", async () => {
    await seed(83, "failed", "<script>PRIVATE-ERROR</script>");
    const response = await handleConsole(request(), env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("#83");
    expect(html).toContain("未分類錯誤");
    expect(html).not.toContain("PRIVATE-");
    expect(html).not.toContain('action="/console/cancel"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const invalid = await handleConsole(request("/console?filter=%3Cscript%3E"), env);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("<script>");
  });

  it("rejects cross-origin, missing-origin, wrong-type, oversized and invalid writes", async () => {
    for (const originValue of ["https://evil.example", "null", ""]) {
      const req = request("/console/pause", "paused=1&revision=0");
      if (originValue) req.headers.set("origin", originValue); else req.headers.delete("origin");
      expect((await handleConsole(req, env)).status).toBe(403);
    }
    const wrongType = request("/console/pause", "paused=1&revision=0");
    wrongType.headers.set("content-type", "text/plain");
    expect((await handleConsole(wrongType, env)).status).toBe(403);
    expect((await handleConsole(request("/console/pause", "x".repeat(1025)), env)).status).toBe(413);
    expect((await handleConsole(request("/console/pause", "paused=maybe&revision=0"), env)).status).toBe(400);
    expect((await handleConsole(request("/console/pause?paused=1"), env)).status).toBe(404);
    expect((await getReminderControl(env.DB)).paused).toBe(0);
  });

  it("persists explicit pause/resume, rejects stale forms and cannot override the deployment switch", async () => {
    const paused = await handleConsole(request("/console/pause", "paused=1&revision=0"), env);
    expect(paused.status).toBe(303);
    expect(paused.headers.get("location")).toBe("/console");
    expect(await getReminderControl(env.DB)).toMatchObject({ paused: 1, revision: 1 });
    expect((await handleConsole(request("/console/pause", "paused=0&revision=0"), env)).status).toBe(409);
    env.NOTIFY_ENABLED = "false";
    expect((await handleConsole(request("/console/pause", "paused=0&revision=1"), env)).status).toBe(409);
    expect((await getReminderControl(env.DB)).paused).toBe(1);
    env.NOTIFY_ENABLED = "true";
    expect((await handleConsole(request("/console/pause", "paused=0&revision=1"), env)).status).toBe(303);
    expect(await getReminderControl(env.DB)).toMatchObject({ paused: 0, revision: 2 });
  });

  it("cancels pending work only, with idempotent repeated cancellation", async () => {
    await seed(41);
    await seed(72, "sending");
    expect((await handleConsole(request("/console/cancel", "id=41"), env)).status).toBe(303);
    expect((await handleConsole(request("/console/cancel", "id=41"), env)).status).toBe(303);
    expect(await env.DB.prepare("SELECT status FROM reminders WHERE id = 41").first("status")).toBe("cancelled");
    expect((await handleConsole(request("/console/cancel", "id=72"), env)).status).toBe(409);
    expect(await env.DB.prepare("SELECT status FROM reminders WHERE id = 72").first("status")).toBe("sending");
    expect((await handleConsole(request("/console/cancel", "id=999"), env)).status).toBe(409);
  });

  it("filters and paginates real rows in deterministic ID order", async () => {
    for (let i = 1; i <= 21; i++) await seed(i, i === 1 ? "unknown" : "pending");
    const first = await (await handleConsole(request(), env)).text();
    expect(first).toContain('filter=all&amp;page=1');
    expect(first).not.toContain('<th scope="row">#1</th>');
    const second = await (await handleConsole(request("/console?page=1"), env)).text();
    expect(second).toContain('<th scope="row">#1</th>');
    expect(second).not.toContain('<th scope="row">#2</th>');
    const issues = await (await handleConsole(request("/console?filter=issues"), env)).text();
    expect(issues).toContain('<th scope="row">#1</th>');
    expect(issues).not.toContain('action="/console/cancel"');
  });

  it("reports storage failures as unconfirmed rather than successful operations", async () => {
    const db = new Proxy(env.DB, { get() { throw new Error("PRIVATE-DB-ERROR"); } });
    const response = await handleConsole(request("/console/pause", "paused=1&revision=0"), { ...env, DB: db });
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("請勿假設操作成功");
    expect(html).not.toContain("PRIVATE-");
  });
});

describe("console status presentation", () => {
  const model: ConsoleModel = { enabled: true, parser: "rule", now: 1000, page: 0, filter: "all", hasMore: false, reminders: [],
    control: { paused: 0, revision: 0, changed_at: null, last_tick_started_at: null, last_tick_finished_at: null, last_tick_status: null } };
  it("does not invite reminder creation while disabled or paused", () => {
    expect(consolePage(model, "", "nonce")).toContain("從 LINE 輸入 @notify");
    for (const input of [{ ...model, enabled: false }, { ...model, control: { ...model.control, paused: 1 } }]) {
      const html = consolePage(input, "", "nonce");
      expect(html).toContain("目前未開放建立提醒");
      expect(html).not.toContain("從 LINE 輸入 @notify");
    }
  });
  it("distinguishes stale, running, failed and completed scheduler checks", () => {
    expect(consolePage(model, "", "nonce")).toContain("排程狀態待確認");
    for (const [state, label] of [["running", "檢查中／尚未完成"], ["error", "最近一次檢查失敗"], ["completed", "最近一次檢查完成"]] as const) {
      expect(consolePage({ ...model, control: { ...model.control, last_tick_started_at: 999, last_tick_status: state } }, "", "nonce")).toContain(label);
    }
    expect(consolePage({ ...model, control: { ...model.control, last_tick_started_at: 699, last_tick_status: "completed" } }, "", "nonce")).toContain("排程狀態待確認");
  });
});

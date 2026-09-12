import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelReminder, claimReminder, handleNotify, runReminders, type Reminder } from "../src/reminders";
import { parseNotifyCommand } from "../src/notify-command";
import worker from "../src/index";
import type { Env, LineEvent, Source } from "../src/types";

let mf: Miniflare;
let env: Env;
let clock: number;
const initialTime = Date.parse("2026-09-12T12:00:00+08:00");

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-09-11", d1Databases: ["DB"], r2Buckets: ["BUCKET"] }));
  env = {
    ...await mf.getBindings<Pick<Env, "DB" | "BUCKET">>(),
    LINE_CHANNEL_SECRET: "test-secret", LINE_CHANNEL_ACCESS_TOKEN: "test-token", NOTIFY_ENABLED: "true",
    NOTIFY_TIME_PARSER: "rule",
  };
  for (const name of ["0001_initial.sql", "0002_note_descriptions.sql", "0003_reminders.sql"]) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await env.DB.batch(sql.split(";").map((statement) => statement.trim()).filter(Boolean).map((statement) => env.DB.prepare(statement)));
  }
});
afterAll(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await env.DB.exec("DELETE FROM reminders");
  env.NOTIFY_ENABLED = "true";
  env.NOTIFY_TIME_PARSER = "rule";
  delete env.AI;
  clock = initialTime;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function event(id = "m1", source: Source = { type: "group", groupId: "G-one", userId: "author" }): LineEvent {
  return { type: "message", timestamp: initialTime, source, replyToken: "reply", message: { id, type: "text", text: "@notify 1分鐘後 合成提醒" } };
}
async function create(input = event()): Promise<Reminder> {
  await handleNotify(env, input, parseNotifyCommand(input.message!.text!, input.timestamp)!);
  return (await env.DB.prepare("SELECT * FROM reminders WHERE source_message_id = ?").bind(input.message!.id).first<Reminder>())!;
}
async function get(id: number): Promise<Reminder> {
  return (await env.DB.prepare("SELECT * FROM reminders WHERE id = ?").bind(id).first<Reminder>())!;
}

describe("reminders on real local D1", () => {
  it("uses AI only when opted in, preserves original task and deduplicates before inference", async () => {
    const run = vi.fn().mockResolvedValue({ response: { unambiguous: true, time_prefix: "後天早上九點", due_local: "2026-09-14 09:00" } });
    env.AI = { run } as unknown as Ai;
    const input = event();
    input.message!.text = "@notify 後天早上九點 合成事項\n第二行";
    expect(await create(input)).toBeNull();
    expect(run).not.toHaveBeenCalled();
    env.NOTIFY_TIME_PARSER = "ai";
    const receipt = await handleNotify(env, input, parseNotifyCommand(input.message!.text, input.timestamp)!);
    expect(JSON.stringify(receipt)).toContain("AI 解讀，請核對時間與事項");
    const saved = await create(input);
    expect(saved).toMatchObject({ text: "合成事項\n第二行", due_at: Date.parse("2026-09-14T01:00:00Z") / 1000 });
    expect(run).toHaveBeenCalledOnce();
    expect(JSON.stringify(run.mock.calls)).not.toContain("G-one");
    expect(JSON.stringify(run.mock.calls)).toContain("2026-09-12T12:00:00");
  });

  it("does not call AI for rules, invalid dates, management, disabled or stale commands", async () => {
    const run = vi.fn();
    env.AI = { run } as unknown as Ai;
    env.NOTIFY_TIME_PARSER = "ai";
    expect(await create()).not.toBeNull();
    for (const text of ["@notify 2027-02-30 09:00 合成事項", "@notify 0分鐘後 合成事項", "@notify 列表", "@notify 取消 abc", "@notify 525601分鐘後 合成事項"]) {
      const input = event(text);
      input.message!.text = text;
      await handleNotify(env, input, parseNotifyCommand(text, input.timestamp)!);
    }
    const input = event("natural");
    input.message!.text = "@notify 後天早上九點 合成事項";
    env.NOTIFY_ENABLED = "false";
    expect(await create(input)).toBeNull();
    env.NOTIFY_ENABLED = "true";
    clock += 3601_000;
    expect(await create(input)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("creates nothing when AI fails or returns an invalid date", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("private provider error"))
      .mockResolvedValueOnce({ response: { unambiguous: true, time_prefix: "後天早上九點", due_local: "2027-02-30 09:00" } });
    env.AI = { run } as unknown as Ai;
    env.NOTIFY_TIME_PARSER = "ai";
    const input = event();
    input.message!.text = "@notify 後天早上九點 合成事項";
    expect(await create(input)).toBeNull();
    expect(await create(input)).toBeNull();
  });

  it("deduplicates concurrent redelivery, preserves due time, but permits a new identical message", async () => {
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.id).toBe(b.id);
    clock += 120_000;
    const replay = await create();
    expect(replay.due_at).toBe(initialTime / 1000 + 60);
    expect(replay.id).toBe(a.id);
    clock = initialTime;
    expect((await create(event("m2"))).id).not.toBe(a.id);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM notes").first("count")).toBe(0);
  });

  it("defaults off, permits cancellation when disabled, and does not push", async () => {
    const reminder = await create();
    Reflect.deleteProperty(env, "NOTIFY_ENABLED");
    const reply = await handleNotify(env, event("other"), { type: "create", dueAt: initialTime / 1000 + 60, text: "test" });
    expect(JSON.stringify(reply)).toContain("尚未啟用");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    clock += 60_000;
    await runReminders(env);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await cancelReminder(env.DB, "group:G-one", reminder.id, clock / 1000))?.status).toBe("cancelled");
  });

  it("isolates lists and cancellation but allows another member of the same group", async () => {
    const reminder = await create();
    expect(await cancelReminder(env.DB, "user:author", reminder.id, clock / 1000)).toBeNull();
    const otherGroup = event("m2", { type: "group", groupId: "G-two", userId: "author" });
    expect(JSON.stringify(await handleNotify(env, otherGroup, { type: "list", offset: 0 }))).not.toContain("合成提醒");
    const sameGroup = event("m3", { type: "group", groupId: "G-one", userId: "someone-else" });
    expect(JSON.stringify(await handleNotify(env, sameGroup, { type: "cancel", id: reminder.id }))).toContain("已取消");
    expect((await cancelReminder(env.DB, "group:G-one", reminder.id, clock / 1000))?.status).toBe("cancelled");
  });

  it("makes cancellation and claiming mutually exclusive", async () => {
    const reminder = await create();
    const now = initialTime / 1000 + 60;
    const [cancelled, claimed] = await Promise.all([
      cancelReminder(env.DB, "group:G-one", reminder.id, now), claimReminder(env.DB, reminder.id, now),
    ]);
    expect(cancelled?.status === "cancelled" ? claimed === null : claimed?.status === "sending").toBe(true);
    const final = await get(reminder.id);
    expect(["cancelled", "sending"]).toContain(final.status);
    if (final.status === "cancelled") expect(await claimReminder(env.DB, reminder.id, now + 1)).toBeNull();
    else expect((await cancelReminder(env.DB, "group:G-one", reminder.id, now + 1))?.status).toBe("sending");
  });

  it("does not send early and overlapping ticks send once to the original group", async () => {
    const reminder = await create();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }));
    clock += 59_000;
    await runReminders(env);
    expect(fetchMock).not.toHaveBeenCalled();
    clock += 1000;
    await Promise.all([runReminders(env), runReminders(env)]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/message/push");
    expect(JSON.parse(String(init?.body))).toMatchObject({ to: "G-one", messages: [{ type: "text", text: expect.stringContaining("合成提醒") }] });
    expect(new Headers(init?.headers).get("X-Line-Retry-Key")).toBe(reminder.retry_key);
    expect((await get(reminder.id)).status).toBe("accepted");
  });

  it("retries network uncertainty with an identical body/key and accepts LINE's dedupe receipt", async () => {
    const reminder = await create();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(new Response(null, { status: 409, headers: { "x-line-accepted-request-id": "accepted" } }));
    clock += 60_000;
    await runReminders(env);
    expect((await get(reminder.id)).status).toBe("sending");
    clock += 59_000;
    await runReminders(env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 1000;
    await runReminders(env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("X-Line-Retry-Key")).toBe(reminder.retry_key);
    expect((await get(reminder.id)).status).toBe("accepted");
  });

  it("recovers after LINE accepts but persisting the result fails", async () => {
    const reminder = await create();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 409, headers: { "x-line-accepted-request-id": "accepted" } }));
    const failingDb = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.includes("SET status = ?, uncertain")) throw new Error("write unavailable");
        return target.prepare(sql);
      };
      return Reflect.get(target, property);
    } });
    clock += 60_000;
    await runReminders({ ...env, DB: failingDb });
    expect((await get(reminder.id)).status).toBe("sending");
    clock += 120_000;
    await runReminders(env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    expect((await get(reminder.id)).status).toBe("accepted");
  });

  it.each([400, 401, 403, 429])("records HTTP %s without retrying or leaking content to logs", async (status) => {
    const reminder = await create();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("sensitive upstream body", { status }));
    clock += 60_000;
    await runReminders(env);
    clock += 180_000;
    await runReminders(env);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await get(reminder.id)).toMatchObject({ status: "failed", last_error: `http_${status}` });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(/合成提醒|G-one|sensitive|test-token/);
  });

  it("expires unsent jobs, bounds uncertain retries, and purges terminal records after 30 days", async () => {
    const reminder = await create();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    clock += 60_000;
    for (const advance of [0, 60, 120, 240, 480, 900]) {
      clock += advance * 1000;
      await runReminders(env);
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect((await get(reminder.id)).status).toBe("unknown");
    clock = initialTime;
    const expired = await create(event("expired"));
    clock = initialTime + 3661_000;
    await runReminders(env);
    expect((await get(expired.id)).status).toBe("expired");
    expect(fetchMock).toHaveBeenCalledTimes(6);
    clock += 31 * 86400_000;
    await runReminders(env);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders").first("n")).toBe(0);
  });

  it("enforces the 100-active limit atomically while still returning duplicate receipts", async () => {
    await env.DB.batch(Array.from({ length: 99 }, (_, i) => env.DB.prepare(`INSERT INTO reminders
      (workspace_key, source_message_id, destination, text, due_at, created_at, retry_key)
      VALUES ('group:G-one', ?, 'G-one', 'seed', ?, ?, ?)`)
      .bind(`seed-${i}`, initialTime / 1000 + 60, initialTime / 1000, crypto.randomUUID())));
    await Promise.all([create(event("last-a")), create(event("last-b"))]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders").first("n")).toBe(100);
    const winner = await env.DB.prepare("SELECT source_message_id FROM reminders WHERE source_message_id LIKE 'last-%'").first<string>("source_message_id");
    expect(await create(event(winner!))).not.toBeNull();
  });

  it("routes a signed webhook through snapshot, parsing, receipt, and duplicate handling", async () => {
    const raw = JSON.stringify({ destination: "test", events: [event("webhook")] });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))));
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {}, props: {} } as ExecutionContext;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null));
    for (let i = 0; i < 2; i++) {
      expect((await worker.fetch(new Request("https://knot.test/webhook", {
        method: "POST", body: raw, headers: { "x-line-signature": signature },
      }), env, ctx)).status).toBe(200);
    }
    await Promise.all(pending);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM reminders").first("n")).toBe(1);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/reply"))).toBe(true);
    expect(JSON.stringify(fetchMock.mock.calls)).toContain("取消提醒");
  });

  it("covers both cancellation orderings and refuses to steal a live lease", async () => {
    const a = await create(event("cancel-first"));
    const b = await create(event("claim-first"));
    clock += 60_000;
    await cancelReminder(env.DB, "group:G-one", a.id, clock / 1000);
    expect(await claimReminder(env.DB, a.id, clock / 1000)).toBeNull();
    expect(await claimReminder(env.DB, b.id, clock / 1000)).toHaveProperty("status", "sending");
    expect((await cancelReminder(env.DB, "group:G-one", b.id, clock / 1000))?.status).toBe("sending");
    expect(await claimReminder(env.DB, b.id, clock / 1000 + 119)).toBeNull();
    expect(await claimReminder(env.DB, b.id, clock / 1000 + 120)).toHaveProperty("uncertain", 1);
  });

  it("does not claim definite failure when a prior attempt's result was lost", async () => {
    const reminder = await create();
    clock += 60_000;
    await claimReminder(env.DB, reminder.id, clock / 1000);
    clock += 120_000;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    await runReminders(env);
    expect((await get(reminder.id)).status).toBe("unknown");
  });

  it("rejects stale new commands, includes the grace boundary, and never retries outside it", async () => {
    const reminder = await create();
    clock = initialTime + 3660_000;
    const response = await handleNotify(env, event("stale"), { type: "create", dueAt: clock / 1000 + 60, text: "stale" });
    expect(JSON.stringify(response)).toContain("延遲超過");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await runReminders(env);
    expect((await get(reminder.id)).status).toBe("accepted");
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain("延遲補發");
    clock = initialTime;
    const old = await create(event("too-old"));
    clock = initialTime + 25 * 3600_000;
    await runReminders(env);
    expect((await get(old.id)).status).toBe("expired");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("lists all reminders through pages, with active jobs ahead of recent history", async () => {
    const reminders = [];
    for (let i = 0; i < 7; i++) reminders.push(await create(event(`page-${i}`)));
    await cancelReminder(env.DB, "group:G-one", reminders[6].id, clock / 1000);
    const first = JSON.stringify(await handleNotify(env, event(), { type: "list", offset: 0 }));
    const second = await handleNotify(env, event(), { type: "list", offset: 5 });
    expect(first).toContain("@notify 列表 5");
    expect(first).not.toContain(`提醒 #${reminders[6].id}`);
    expect(second).toHaveProperty("contents.contents.1.body.contents.0.contents.1.text", `提醒 #${reminders[6].id}`);
    expect(second).toHaveProperty("contents.contents.1.body.contents.1.text", "已取消");
    expect(JSON.stringify(second)).not.toContain("下一頁");
  });
});

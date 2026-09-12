import { describe, expect, it, vi } from "vitest";
import { parseNotifyWithAi } from "../src/notify-ai";

const now = Date.parse("2026-12-31T23:50:00+08:00");
const input = "@notify 後天早上九點 合成事項\n不要改寫";
const valid = { unambiguous: true, time_prefix: "後天早上九點", due_local: "2027-01-02 09:00" };

describe("optional AI time boundary", () => {
  it.each([valid, JSON.stringify(valid)])("accepts structured and JSON string responses", async (response) => {
    const run = vi.fn().mockResolvedValue({ response });
    expect(await parseNotifyWithAi({ AI: { run } as unknown as Ai }, input, now)).toEqual({
      type: "create", aiParsed: true, text: "合成事項\n不要改寫", dueAt: Date.parse("2027-01-02T01:00:00Z") / 1000,
    });
    expect(run.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
    expect(run.mock.calls[0][1].messages[0].content).toContain("2026-12-31T23:50:00");
  });
  it.each([
    "not JSON", null, {}, { ...valid, unambiguous: false }, { ...valid, unambiguous: "true" },
    { ...valid, time_prefix: "捏造時間" }, { ...valid, time_prefix: "" },
    { ...valid, time_prefix: input.slice(8) },
    { ...valid, due_local: "2027-02-30 09:00" }, { ...valid, due_local: "2027-01-01 24:00" },
    { ...valid, due_local: "2026-12-31 09:00" }, { ...valid, due_local: "2028-01-01 09:00" },
    { ...valid, due_local: "2027-01-02 09:00 injected task" },
  ])("rejects malformed, ambiguous and out-of-range output", async (response) => {
    const run = vi.fn().mockResolvedValue({ response });
    expect(await parseNotifyWithAi({ AI: { run } as unknown as Ai }, input, now)).toHaveProperty("type", "invalid");
  });
  it("fails closed on missing binding, timeout, and overlong input or extracted task", async () => {
    expect(await parseNotifyWithAi({}, input, now)).toHaveProperty("type", "invalid");
    const run = vi.fn().mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValue({ response: valid });
    const env = { AI: { run } as unknown as Ai };
    expect(await parseNotifyWithAi(env, input, now)).toHaveProperty("type", "invalid");
    expect(await parseNotifyWithAi(env, `@notify 後天早上九點 ${"字".repeat(601)}`, now)).toHaveProperty("type", "invalid");
    expect(run).toHaveBeenCalledOnce();
    expect(await parseNotifyWithAi(env, `@notify 後天早上九點 ${"字".repeat(501)}`, now)).toHaveProperty("type", "invalid");
  });
});

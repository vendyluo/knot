import { describe, expect, it } from "vitest";
import { parseNotifyCommand, reminderTime } from "../src/notify-command";

describe("notify command time contract", () => {
  const time = Date.parse("2026-12-31T23:50:12+08:00");
  it("resolves relative time from the event, preserving seconds", () => {
    expect(parseNotifyCommand("@notify 30分鐘後 關烤箱", time)).toEqual({
      type: "create", dueAt: Date.parse("2027-01-01T00:20:12+08:00") / 1000, text: "關烤箱",
    });
  });
  it("resolves tomorrow across the Taipei year boundary rather than UTC midnight", () => {
    expect(parseNotifyCommand("@notify 明天 09:00 帶健保卡", time)).toEqual({
      type: "create", dueAt: Date.parse("2027-01-01T01:00:00Z") / 1000, text: "帶健保卡",
    });
    expect(parseNotifyCommand("@notify 明天 09:00 帶健保卡", Date.parse("2027-01-01T00:01:00+08:00")))
      .toHaveProperty("dueAt", Date.parse("2027-01-02T01:00:00Z") / 1000);
  });
  it("accepts an exact future date and retains multiline text", () => {
    expect(parseNotifyCommand("@notify 2027-01-02 18:30 訂餐廳\n三位", time)).toEqual({
      type: "create", dueAt: Date.parse("2027-01-02T10:30:00Z") / 1000, text: "訂餐廳\n三位",
    });
  });
  it.each(["2027-02-29 09:00", "2027-02-30 09:00", "2027-01-01 24:00", "2027-01-01 09:60", "九點", "下週", "0分鐘後", "2026-12-31 22:00"])("rejects %s instead of guessing", (when) => {
    expect(parseNotifyCommand(`@notify ${when} 測試`, time)).toHaveProperty("type", "invalid");
  });
  it("checks both sides of length and scheduling boundaries", () => {
    expect(parseNotifyCommand(`@notify 1分鐘後 ${"🙂".repeat(500)}`, time)).toHaveProperty("type", "create");
    expect(parseNotifyCommand(`@notify 1分鐘後 ${"🙂".repeat(501)}`, time)).toHaveProperty("type", "invalid");
    expect(parseNotifyCommand("@notify 525600分鐘後 測試", time)).toHaveProperty("type", "create");
    expect(parseNotifyCommand("@notify 525601分鐘後 測試", time)).toHaveProperty("type", "invalid");
    expect(parseNotifyCommand("@notify 1分鐘後 ", time)).toHaveProperty("type", "invalid");
  });
  it("keeps ordinary chat silent and supports management commands", () => {
    expect(parseNotifyCommand("明天提醒我", time)).toBeNull();
    expect(parseNotifyCommand("@notifyx 明天", time)).toBeNull();
    expect(parseNotifyCommand("@notify", time)).toEqual({ type: "help" });
    expect(parseNotifyCommand("@notify 列表 5", time)).toEqual({ type: "list", offset: 5 });
    expect(parseNotifyCommand("@notify 取消 83", time)).toEqual({ type: "cancel", id: 83 });
    expect(parseNotifyCommand("@notify 取消 9007199254740993", time)).toHaveProperty("type", "invalid");
    expect(reminderTime(Date.parse("2027-01-01T01:00:00Z") / 1000)).toContain("09:00");
  });
});

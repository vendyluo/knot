import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands";
import { helpMessage, notesMessage, retrievedMessage, savedMessage, textMessage, reminderMessage, reminderListMessage } from "../src/messages";
import type { Reminder } from "../src/reminders";

describe("LINE message presentation", () => {
  const reminder: Reminder = {
    id: 83, workspace_key: "group:test", source_message_id: "m83", destination: "test",
    text: "帶健保卡", due_at: Date.parse("2026-09-13T01:00:00Z") / 1000,
    status: "pending", retry_key: "not-exposed", push_body: null, attempts: 0,
    lease_token: null, uncertain: 0, last_error: null,
  };

  it("puts reminder cancellation in the persistent card and makes group visibility explicit", () => {
    const message = reminderMessage(reminder);
    expect(message).toHaveProperty("contents.footer.contents.0.action.text", "@notify 取消 83");
    expect(message).not.toHaveProperty("quickReply");
    const payload = JSON.stringify(message);
    expect(payload).toContain("此群組所有成員可見");
    expect(payload).toContain("09:00");
    expect(payload).toContain("台北時間");
    expect(payload).not.toContain("not-exposed");
    expect(JSON.stringify(reminderMessage({ ...reminder, workspace_key: "user:test" }))).toContain("私人聊天室");
  });

  it.each(["sending", "accepted", "cancelled", "failed", "expired", "unknown"] as const)("does not offer cancellation or claim pending for %s", (status) => {
    const payload = JSON.stringify(reminderMessage({ ...reminder, status }));
    expect(payload).not.toContain("取消提醒");
    expect(payload).not.toContain("已設定");
    if (status === "accepted") expect(payload).toContain("不代表已讀");
  });

  it("paginates reminder cards without truncating long items and explains disabled sending", () => {
    const text = "🙂".repeat(500);
    const message = reminderListMessage(Array.from({ length: 5 }, (_, i) => ({ ...reminder, id: 83 + i, text })), 5, true, false);
    expect(message).toHaveProperty("contents.contents.0.body.contents.2.text", text);
    expect(message).toHaveProperty("contents.contents.5.footer.contents.0.action.text", "@notify 列表 10");
    expect(message).toHaveProperty("contents.contents.5.footer.contents.1.action.text", "@notify 列表");
    expect(JSON.stringify(message)).toContain("目前不會發送 Push");
    expect(new TextEncoder().encode(JSON.stringify(message.contents)).length).toBeLessThan(50_000);
    expect(JSON.stringify(reminderListMessage([], 0, false, true))).toContain("沒有提醒");
  });

  it.each(["text", "image", "conversation"])("opens the saved %s from the card without quick replies", (kind) => {
    const message = savedMessage(47, kind, { description: "測試記事", itemCount: 3 });
    expect(message).toHaveProperty("contents.body.contents.3.action", {
      type: "message", label: "查看這則", text: "@memo 取出 47",
    });
    expect(parseCommand("@memo 取出 47")).toEqual({ type: "retrieve", id: 47 });
  });

  it("makes each whole row retrieve its own note rather than its position", () => {
    const message = notesMessage([83, 12, 49].map((id) => ({
      id, kind: "message", description: `測試 ${id}`, item_count: 1,
      preview: null, primary_kind: "image", attachment_count: 1, file_name: null,
    })));
    for (const [index, id] of [83, 12, 49].entries()) {
      expect(message).toHaveProperty(`contents.body.contents.2.contents.${index * 2}.action`, {
        type: "message", label: "查看記事", text: `@memo 取出 ${id}`,
      });
      expect(message).toHaveProperty(`contents.body.contents.2.contents.${index * 2}.contents.2.text`, "查看 ›");
    }
    expect(message).not.toHaveProperty("contents.body.contents.2.contents.1.action");
  });

  it("identifies a saved video and exposes useful next actions", () => {
    const message = savedMessage(17, "video");

    expect(message.type).toBe("flex");
    if (message.type !== "flex") return;
    expect(message.altText).toContain("影片記事 #17");
    expect(JSON.stringify(message.contents)).toContain("影片已從短期快照移至永久保存");
    expect(message.quickReply?.items.map((item) => item.action.text)).toEqual(["@memo 列表", "@memo 說明"]);
  });

  it("labels non-image application content as a file in the recent list", () => {
    const message = notesMessage([
      {
        id: 9,
        kind: "message",
        description: null,
        item_count: 1,
        preview: null,
        primary_kind: "file",
        attachment_count: 1,
        file_name: null,
      },
    ]);

    expect(message.type).toBe("flex");
    if (message.type !== "flex") return;
    expect(message.altText).toBe("Knot 最近 1 則記事");
    expect(JSON.stringify(message.contents)).toContain("檔案");
  });

  it("explains explicit retention without implying that all chat is permanent", () => {
    const message = helpMessage();

    expect(message.type).toBe("flex");
    if (message.type !== "flex") return;
    const payload = JSON.stringify(message.contents);
    expect(payload).toContain("暫存一般訊息 24 小時");
    expect(payload).toContain("明確保存後");
  });

  it("adds a help shortcut only when requested", () => {
    expect(textMessage("完成")).not.toHaveProperty("quickReply");
    expect(textMessage("看不懂", true)).toHaveProperty("quickReply.items.0.action.text", "@memo 說明");
  });

  it("shows saved text and a time-limited media download action", () => {
    const message = retrievedMessage(
      {
        id: 23,
        kind: "message",
        description: "北海道住宿候選",
        items: [{ kind: "image", text: "北海道飯店", position: 0 }],
        attachments: [{ id: 4, r2_key: "permanent/image", content_type: "image/jpeg", file_name: null }],
      },
      ["https://example.com/download/4?signed=yes"],
    );

    expect(message.type).toBe("flex");
    if (message.type !== "flex") return;
    const payload = JSON.stringify(message.contents);
    expect(payload).toContain("北海道住宿候選");
    expect(payload).toContain("北海道飯店");
    expect(payload).toContain("下載圖片");
    expect(payload).toContain("15 分鐘後失效");
    expect(payload).toContain("https://example.com/download/4?signed=yes");
  });

  it("uses descriptions before text and file names in recent-note previews", () => {
    const message = notesMessage([
      {
        id: 31,
        kind: "message",
        description: "結婚影片完整版",
        item_count: 1,
        preview: "lower-priority text",
        primary_kind: "video",
        attachment_count: 1,
        file_name: "lower-priority.mp4",
      },
    ]);

    expect(message.type).toBe("flex");
    if (message.type !== "flex") return;
    const payload = JSON.stringify(message.contents);
    expect(payload).toContain("結婚影片完整版");
    expect(payload).not.toContain("lower-priority");
    expect(payload).toContain("影片記事 #31");
  });
});

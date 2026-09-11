import { describe, expect, it } from "vitest";
import { helpMessage, notesMessage, retrievedMessage, savedMessage, textMessage } from "../src/messages";

describe("LINE message presentation", () => {
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

import type { LineReplyMessage } from "./types";
import type { NoteDetail } from "./storage";

export interface NoteSummaryView {
  id: number;
  kind: string;
  item_count: number;
  preview: string | null;
  primary_kind: string | null;
  attachment_count: number;
}

const KNOT_GREEN = "#168C63";
const INK = "#25332E";
const MUTED = "#738079";
const SURFACE = "#F3F8F5";

const quickReply = {
  items: [
    { type: "action" as const, action: { type: "message" as const, label: "最近記事", text: "@memo 列表" } },
    { type: "action" as const, action: { type: "message" as const, label: "使用說明", text: "@memo 說明" } },
  ],
};

function messageKind(kind: string | null): { icon: string; label: string } {
  switch (kind) {
    case "image":
      return { icon: "▧", label: "圖片" };
    case "video":
      return { icon: "▶", label: "影片" };
    case "audio":
      return { icon: "♪", label: "音訊" };
    case "file":
      return { icon: "▤", label: "檔案" };
    case "conversation":
      return { icon: "◌", label: "對話" };
    default:
      return { icon: "◆", label: "文字" };
  }
}

function contentTypeKind(contentType: string | null): string {
  if (contentType?.startsWith("image/")) return "image";
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("audio/")) return "audio";
  return "file";
}

function baseBubble(body: Record<string, unknown>, footer?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "bubble",
    size: "kilo",
    styles: { body: { backgroundColor: "#FFFFFF" }, footer: { separator: false } },
    body,
    ...(footer ? { footer } : {}),
  };
}

function brandHeader(status: string): Record<string, unknown>[] {
  return [
    {
      type: "box",
      layout: "horizontal",
      alignItems: "center",
      contents: [
        { type: "text", text: "KNOT", color: KNOT_GREEN, weight: "bold", size: "xs", flex: 0 },
        { type: "text", text: status, color: MUTED, size: "xs", align: "end" },
      ],
    },
  ];
}

export function savedMessage(id: number, kind: string, itemCount = 1): LineReplyMessage {
  const display = messageKind(kind);
  const description = kind === "conversation" ? `${itemCount} 則訊息已打成一個結` : `${display.label}已從短期快照移至永久保存`;

  return {
    type: "flex",
    altText: `Knot 已永久保存${display.label}記事 #${id}`,
    contents: baseBubble({
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      spacing: "lg",
      contents: [
        ...brandHeader("已永久保存"),
        {
          type: "box",
          layout: "horizontal",
          alignItems: "center",
          spacing: "md",
          contents: [
            {
              type: "box",
              layout: "vertical",
              width: "44px",
              height: "44px",
              cornerRadius: "22px",
              backgroundColor: SURFACE,
              justifyContent: "center",
              alignItems: "center",
              contents: [{ type: "text", text: display.icon, color: KNOT_GREEN, size: "xl", align: "center" }],
            },
            {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              contents: [
                { type: "text", text: `${display.label}記事 #${id}`, color: INK, weight: "bold", size: "lg" },
                { type: "text", text: description, color: MUTED, size: "sm", wrap: true },
              ],
            },
          ],
        },
        {
          type: "box",
          layout: "vertical",
          backgroundColor: SURFACE,
          cornerRadius: "10px",
          paddingAll: "12px",
          contents: [{ type: "text", text: "只有你明確保存的內容會永久留下", color: MUTED, size: "xs", wrap: true }],
        },
      ],
    }),
    quickReply,
  };
}

function noteTitle(note: NoteSummaryView): string {
  if (note.kind === "conversation") return `對話 · ${note.item_count} 則`;
  if (note.preview) return note.preview.replace(/\s+/g, " ");
  const display = messageKind(note.primary_kind);
  return note.attachment_count > 1 ? `${display.label} · ${note.attachment_count} 個附件` : display.label;
}

export function notesMessage(notes: NoteSummaryView[]): LineReplyMessage {
  const rows = notes.flatMap((note, index) => {
    const display = messageKind(note.kind === "conversation" ? "conversation" : note.primary_kind);
    const row: Record<string, unknown> = {
      type: "box",
      layout: "horizontal",
      alignItems: "center",
      spacing: "md",
      paddingTop: index === 0 ? "0px" : "12px",
      paddingBottom: "12px",
      contents: [
        { type: "text", text: display.icon, color: KNOT_GREEN, size: "lg", flex: 0 },
        {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          contents: [
            { type: "text", text: noteTitle(note), color: INK, size: "sm", weight: "bold", wrap: true, maxLines: 2 },
            { type: "text", text: `記事 #${note.id}`, color: MUTED, size: "xs" },
          ],
        },
      ],
    };
    return index === notes.length - 1
      ? [row]
      : [row, { type: "separator", color: "#E5ECE8" } as Record<string, unknown>];
  });

  return {
    type: "flex",
    altText: `Knot 最近 ${notes.length} 則記事`,
    contents: baseBubble(
      {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        spacing: "lg",
        contents: [
          ...brandHeader(`${notes.length} 則記事`),
          { type: "text", text: "最近留下的結", color: INK, weight: "bold", size: "xl" },
          { type: "box", layout: "vertical", contents: rows },
        ],
      },
      {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            color: KNOT_GREEN,
            action: { type: "message", label: "怎麼保存？", text: "@memo 說明" },
          },
        ],
      },
    ),
  };
}

export function helpMessage(): LineReplyMessage {
  const commands = [
    ["回覆訊息 + @memo", "保存文字、圖片、影片、音訊或檔案"],
    ["@memo 文字 …", "直接寫下一則文字記事"],
    ["@memo 對話 10", "保存最近一段對話，最多 50 則"],
    ["@memo 列表", "查看這個聊天室最近的記事"],
    ["@memo 取出 12", "顯示文字或取得 15 分鐘下載連結"],
    ["@memo 刪除 12", "刪除指定記事與永久附件"],
  ];

  return {
    type: "flex",
    altText: "Knot 使用說明：回覆訊息並輸入 @memo 即可永久保存",
    contents: baseBubble({
      type: "box",
      layout: "vertical",
      paddingAll: "20px",
      spacing: "lg",
      contents: [
        ...brandHeader("使用說明"),
        { type: "text", text: "把重要的事，打個結。", color: INK, weight: "bold", size: "xl", wrap: true },
        {
          type: "text",
          text: "Knot 只會暫存一般訊息 24 小時；你明確保存後，內容才會永久留下。",
          color: MUTED,
          size: "sm",
          wrap: true,
        },
        {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: commands.map(([command, description]) => ({
            type: "box",
            layout: "vertical",
            spacing: "xs",
            contents: [
              { type: "text", text: command, color: KNOT_GREEN, weight: "bold", size: "sm" },
              { type: "text", text: description, color: MUTED, size: "xs", wrap: true },
            ],
          })),
        },
      ],
    }),
    quickReply: {
      items: [{ type: "action", action: { type: "message", label: "查看最近記事", text: "@memo 列表" } }],
    },
  };
}

export function retrievedMessage(note: NoteDetail, downloadUrls: string[]): LineReplyMessage {
  const textItems = note.items.map((item) => item.text?.trim()).filter((text): text is string => Boolean(text));
  const visibleText = textItems.join("\n\n").slice(0, 3000);
  const attachmentButtons = note.attachments.slice(0, 10).map((attachment, index) => {
    const display = messageKind(contentTypeKind(attachment.content_type));
    return {
      type: "button",
      style: index === 0 ? "primary" : "secondary",
      height: "sm",
      color: KNOT_GREEN,
      action: {
        type: "uri",
        label: `下載${display.label}${note.attachments.length > 1 ? ` ${index + 1}` : ""}`,
        uri: downloadUrls[index],
      },
    };
  });

  const contents: Record<string, unknown>[] = [
    ...brandHeader(`記事 #${note.id}`),
    { type: "text", text: "把這個結取回來", color: INK, weight: "bold", size: "xl", wrap: true },
  ];
  if (visibleText) {
    contents.push({
      type: "box",
      layout: "vertical",
      backgroundColor: SURFACE,
      cornerRadius: "10px",
      paddingAll: "14px",
      contents: [{ type: "text", text: visibleText, color: INK, size: "sm", wrap: true }],
    });
  }
  if (attachmentButtons.length) {
    contents.push(
      { type: "text", text: "下載連結將在 15 分鐘後失效", color: MUTED, size: "xs", wrap: true },
      { type: "box", layout: "vertical", spacing: "sm", contents: attachmentButtons },
    );
  }
  if (note.attachments.length > 10) {
    contents.push({ type: "text", text: `此記事有 ${note.attachments.length} 個附件，目前顯示前 10 個。`, color: MUTED, size: "xs", wrap: true });
  }

  return {
    type: "flex",
    altText: `Knot 已取出記事 #${note.id}${note.attachments.length ? "，下載連結 15 分鐘內有效" : ""}`,
    contents: baseBubble({ type: "box", layout: "vertical", paddingAll: "20px", spacing: "lg", contents }),
    quickReply,
  };
}

export function textMessage(text: string, withHelp = false): LineReplyMessage {
  return {
    type: "text",
    text,
    ...(withHelp
      ? {
          quickReply: {
            items: [{ type: "action", action: { type: "message", label: "使用說明", text: "@memo 說明" } }],
          },
        }
      : {}),
  };
}

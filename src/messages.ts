import type { LineReplyMessage } from "./types";
import type { NoteDetail } from "./storage";
import type { Reminder } from "./reminders";
import { reminderTime } from "./notify-command";

export interface NoteSummaryView {
  id: number;
  kind: string;
  description: string | null;
  item_count: number;
  preview: string | null;
  primary_kind: string | null;
  attachment_count: number;
  file_name: string | null;
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

export function savedMessage(
  id: number,
  kind: string,
  options: { itemCount?: number; description?: string } = {},
): LineReplyMessage {
  const display = messageKind(kind);
  const detail = options.description
    ? `${display.label}記事 #${id} · 已移至永久保存`
    : kind === "conversation"
      ? `${options.itemCount ?? 1} 則訊息已打成一個結`
      : `${display.label}已從短期快照移至永久保存`;

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
                {
                  type: "text",
                  text: options.description ?? `${display.label}記事 #${id}`,
                  color: INK,
                  weight: "bold",
                  size: "lg",
                  wrap: true,
                  maxLines: 2,
                },
                { type: "text", text: detail, color: MUTED, size: "sm", wrap: true },
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
        {
          type: "button",
          style: "primary",
          height: "sm",
          color: KNOT_GREEN,
          action: { type: "message", label: "查看這則", text: `@memo 取出 ${id}` },
        },
      ],
    }),
    quickReply,
  };
}

function noteTitle(note: NoteSummaryView): string {
  if (note.description) return note.description.replace(/\s+/g, " ");
  if (note.kind === "conversation") return `對話 · ${note.item_count} 則`;
  if (note.preview) return note.preview.replace(/\s+/g, " ");
  if (note.file_name) return note.file_name;
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
      action: { type: "message", label: "查看記事", text: `@memo 取出 ${note.id}` },
      contents: [
        { type: "text", text: display.icon, color: KNOT_GREEN, size: "lg", flex: 0 },
        {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          contents: [
            { type: "text", text: noteTitle(note), color: INK, size: "sm", weight: "bold", wrap: true, maxLines: 2 },
            { type: "text", text: `${display.label}記事 #${note.id}`, color: MUTED, size: "xs" },
          ],
        },
        { type: "text", text: "查看 ›", color: KNOT_GREEN, size: "sm", flex: 0 },
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
    ["回覆訊息 + @memo 描述", "保存文字、圖片、影片、音訊或檔案；描述可省略"],
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
    {
      type: "text",
      text: note.description ?? "把這個結取回來",
      color: INK,
      weight: "bold",
      size: "xl",
      wrap: true,
      maxLines: 3,
    },
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

const REMINDER_STATUS: Record<Reminder["status"], string> = {
  pending: "已設定・待提醒", sending: "發送中／等待重試", accepted: "已送交 LINE（不代表已讀）",
  cancelled: "已取消", failed: "發送失敗・請洽管理者", expired: "已過期・未發送", unknown: "發送結果未確認",
};

export function reminderMessage(reminder: Reminder, aiParsed = false): Extract<LineReplyMessage, { type: "flex" }> {
  const location = reminder.workspace_key.startsWith("user:") ? "這個私人聊天室" : "此群組所有成員可見";
  const status = REMINDER_STATUS[reminder.status] + (aiParsed ? "（AI 解讀，請核對時間與事項）" : "");
  const actions = [
    ...(reminder.status === "pending" ? [{ type: "button", style: "secondary", height: "sm", action: {
      type: "message", label: "取消提醒", text: `@notify 取消 ${reminder.id}`,
    } }] : []),
    { type: "button", style: "link", height: "sm", action: { type: "message", label: "待提醒列表", text: "@notify 列表" } },
  ];
  return {
    type: "flex",
    altText: `Knot 提醒 #${reminder.id}：${status}`,
    contents: baseBubble({
      type: "box", layout: "vertical", paddingAll: "20px", spacing: "md",
      contents: [
        ...brandHeader(`提醒 #${reminder.id}`),
        { type: "text", text: status, color: KNOT_GREEN, weight: "bold", wrap: true },
        { type: "text", text: reminder.text, color: INK, size: "sm", wrap: true },
        { type: "text", text: reminderTime(reminder.due_at), color: INK, size: "sm", wrap: true },
        { type: "text", text: `提醒位置：${location}`, color: MUTED, size: "xs", wrap: true },
        ...(reminder.last_error ? [{ type: "text", text: `診斷：${reminder.last_error}`, color: MUTED, size: "xs", wrap: true }] : []),
      ],
    }, { type: "box", layout: "vertical", paddingAll: "12px", contents: actions }),
  };
}

export function reminderListMessage(reminders: Reminder[], offset: number, hasMore: boolean, enabled: boolean): Extract<LineReplyMessage, { type: "flex" }> {
  const navigation = baseBubble({
    type: "box", layout: "vertical", paddingAll: "20px", spacing: "md",
    contents: [
      ...brandHeader("提醒列表"),
      { type: "text", text: reminders.length ? `第 ${offset + 1}–${offset + reminders.length} 筆・待提醒優先，其餘為近期紀錄` : "這一頁沒有提醒。", wrap: true, size: "sm" },
      { type: "text", text: enabled ? "到期 Push 使用 OA 額度；已送交 LINE 不代表送達。" : "管理者已停用提醒，目前不會發送 Push。", wrap: true, size: "xs", color: MUTED },
    ],
  }, {
    type: "box", layout: "vertical", paddingAll: "12px", contents: [
      ...(hasMore ? [{ type: "button", style: "primary", color: KNOT_GREEN, action: { type: "message", label: "下一頁", text: `@notify 列表 ${offset + 5}` } }] : []),
      { type: "button", style: "link", action: { type: "message", label: offset ? "回到第一頁" : "提醒說明", text: offset ? "@notify 列表" : "@notify 說明" } },
    ],
  });
  return {
    type: "flex", altText: `Knot 提醒列表${enabled ? "" : "（已停用發送）"}`,
    contents: { type: "carousel", contents: [...reminders.map((reminder) => reminderMessage(reminder).contents), navigation] },
  };
}

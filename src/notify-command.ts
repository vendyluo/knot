export type NotifyCommand =
  | { type: "create"; dueAt: number; text: string; aiParsed?: boolean }
  | { type: "list"; offset: number }
  | { type: "cancel"; id: number }
  | { type: "help" }
  | { type: "invalid"; reason: string; allowAi?: boolean };

export const NOTIFY_HELP = "單次提醒（台北時間）\n@notify 30分鐘後 關烤箱\n@notify 明天 09:00 帶健保卡\n@notify 2026-09-20 18:30 訂餐廳\n@notify 列表\n@notify 取消 42\n事項最多 500 字，最遠 365 天。到期以分鐘級 Push 發送，會使用 OA 額度，不保證準時送達。";
const DAY = 86_400_000;
const TAIPEI_OFFSET = 8 * 3_600_000;

export function parseNotifyCommand(text: string, eventTime: number): NotifyCommand | null {
  const match = text.trim().match(/^@notify(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const argument = match[1]?.trim() ?? "";
  if (!argument || argument === "說明") return { type: "help" };
  const list = argument.match(/^列表(?:\s+(\d+))?$/);
  if (list && Number.isSafeInteger(Number(list[1] ?? 0))) {
    return { type: "list", offset: Number(list[1] ?? 0) };
  }
  const cancel = argument.match(/^取消\s+(\d+)$/);
  if (cancel && Number.isSafeInteger(Number(cancel[1])) && Number(cancel[1]) > 0) {
    return { type: "cancel", id: Number(cancel[1]) };
  }

  let dueAt = NaN;
  let body = "";
  const relative = argument.match(/^(\d+)分鐘後\s+([\s\S]+)$/);
  const tomorrow = argument.match(/^明天\s+(\d{2}):(\d{2})\s+([\s\S]+)$/);
  const absolute = argument.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s+([\s\S]+)$/);
  if (relative && Number(relative[1]) > 0) {
    dueAt = eventTime + Number(relative[1]) * 60_000;
    body = relative[2];
  } else if (tomorrow || absolute) {
    const date = tomorrow
      ? new Date(eventTime + TAIPEI_OFFSET + DAY).toISOString().slice(0, 10)
      : absolute![1];
    const hour = tomorrow ? tomorrow[1] : absolute![2];
    const minute = tomorrow ? tomorrow[2] : absolute![3];
    const local = `${date}T${hour}:${minute}:00`;
    dueAt = Date.parse(`${local}+08:00`);
    // Date.parse normalizes dates such as February 30. Reject those, and 24:00.
    if (!Number.isFinite(dueAt) || new Date(dueAt + TAIPEI_OFFSET).toISOString().slice(0, 19) !== local) {
      return { type: "invalid", reason: "日期或時間無效，請使用有效日期及 00:00–23:59。" };
    }
    body = tomorrow ? tomorrow[3] : absolute![4];
  }
  body = body.trim();
  if (!Number.isFinite(dueAt) || !body) {
    return {
      type: "invalid", reason: `請提供明確時間及事項。\n${NOTIFY_HELP}`,
      allowAi: !relative && !tomorrow && !absolute && !/^(?:列表|取消|說明)(?:\s|$)/.test(argument),
    };
  }
  if (Array.from(body).length > 500) return { type: "invalid", reason: "提醒事項最多 500 個字。" };
  if (dueAt <= eventTime || dueAt - eventTime > 365 * DAY) {
    return { type: "invalid", reason: "請設定未來 365 天內的時間。" };
  }
  return { type: "create", dueAt: Math.floor(dueAt / 1000), text: body };
}

export function reminderTime(seconds: number): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(seconds * 1000)) + " · 台北時間";
}

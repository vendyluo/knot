import { push } from "./line";
import { reminderMessage, reminderListMessage, textMessage } from "./messages";
import { NOTIFY_HELP, reminderTime, type NotifyCommand } from "./notify-command";
import { parseNotifyWithAi } from "./notify-ai";
import { workspaceKey } from "./storage";
import type { Env, LineEvent, LineReplyMessage } from "./types";

export interface Reminder {
  id: number;
  workspace_key: string;
  source_message_id: string;
  destination: string;
  text: string;
  due_at: number;
  status: "pending" | "sending" | "accepted" | "cancelled" | "failed" | "expired" | "unknown";
  retry_key: string;
  push_body: string | null;
  attempts: number;
  lease_token: string | null;
  uncertain: number;
  last_error: string | null;
}

const GRACE = 3600;
const MAX_ATTEMPTS = 6;
const LEASE = 120;
const BATCH = 10;

export async function cancelReminder(db: D1Database, workspace: string, id: number, now: number): Promise<Reminder | null> {
  await db.prepare("UPDATE reminders SET status = 'cancelled', finished_at = ? WHERE id = ? AND workspace_key = ? AND status = 'pending'")
    .bind(now, id, workspace).run();
  return db.prepare("SELECT * FROM reminders WHERE id = ? AND workspace_key = ?").bind(id, workspace).first<Reminder>();
}

export async function handleNotify(env: Env, event: LineEvent, command: NotifyCommand): Promise<LineReplyMessage> {
  const workspace = workspaceKey(event.source);
  const now = Math.floor(Date.now() / 1000);
  if (command.type === "help") return textMessage(NOTIFY_HELP);
  if (command.type === "invalid" && (!command.allowAi || env.NOTIFY_TIME_PARSER !== "ai")) return textMessage(command.reason);
  if (command.type === "cancel") {
    const reminder = await cancelReminder(env.DB, workspace, command.id, now);
    if (!reminder) return textMessage(`找不到提醒 #${command.id}。`);
    if (reminder.status === "sending") return textMessage(`提醒 #${command.id} 已開始發送，無法保證取消。`);
    return reminderMessage(reminder);
  }
  if (command.type === "list") {
    const rows = await env.DB.prepare(`SELECT * FROM reminders WHERE workspace_key = ?
      ORDER BY CASE WHEN status IN ('pending', 'sending') THEN 0 ELSE 1 END,
      CASE WHEN status IN ('pending', 'sending') THEN due_at END ASC, id DESC LIMIT 6 OFFSET ?`)
      .bind(workspace, command.offset).all<Reminder>();
    return reminderListMessage(rows.results.slice(0, 5), command.offset, rows.results.length > 5, env.NOTIFY_ENABLED === "true");
  }
  // Look up duplicates before date validation, so an old webhook returns its existing receipt.
  const existing = await env.DB.prepare("SELECT * FROM reminders WHERE source_message_id = ? AND workspace_key = ?")
    .bind(event.message!.id, workspace).first<Reminder>();
  if (existing) return reminderMessage(existing);
  if (env.NOTIFY_ENABLED !== "true") return textMessage("此自架 OA 尚未啟用提醒，未建立排程。請由管理者確認 Push 額度後啟用。");
  if (now * 1000 - event.timestamp > GRACE * 1000) {
    return textMessage("時間已過或這則設定訊息延遲超過 1 小時，未建立提醒。請重新設定未來時間。");
  }
  if (command.type === "invalid") {
    command = await parseNotifyWithAi(env, event.message!.text!, event.timestamp);
    if (command.type !== "create") return textMessage(command.type === "invalid" ? command.reason : NOTIFY_HELP);
  }
  if (command.dueAt <= Math.floor(Date.now() / 1000)) return textMessage("時間已過，未建立提醒。請重新設定未來時間。");
  const destination = workspace.slice(workspace.indexOf(":") + 1);
  const created = await env.DB.prepare(`INSERT INTO reminders
    (workspace_key, source_message_id, destination, text, due_at, created_at, retry_key)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE
    (SELECT COUNT(*) FROM reminders WHERE workspace_key = ? AND status IN ('pending', 'sending')) < 100
    ON CONFLICT(source_message_id) DO NOTHING RETURNING *`)
    .bind(workspace, event.message!.id, destination, command.text, command.dueAt, now, crypto.randomUUID(), workspace)
    .first<Reminder>();
  // Concurrent redelivery can win the insert between our first lookup and this write.
  const reminder = created ?? await env.DB.prepare("SELECT * FROM reminders WHERE source_message_id = ? AND workspace_key = ?")
    .bind(event.message!.id, workspace).first<Reminder>();
  return reminder ? reminderMessage(reminder, Boolean(created && command.aiParsed)) : textMessage("這個聊天室已達 100 筆待提醒上限，請先取消不需要的提醒。");
}

export async function claimReminder(db: D1Database, id: number, now: number): Promise<Reminder | null> {
  return db.prepare(`UPDATE reminders SET status = 'sending', lease_until = ?, lease_token = ?, attempts = attempts + 1,
    uncertain = CASE WHEN status = 'sending' AND last_error IS NULL THEN 1 ELSE uncertain END
    WHERE id = ? AND due_at <= ? AND due_at >= ? AND attempts < ?
    AND (status = 'pending' OR (status = 'sending' AND lease_until <= ?)) RETURNING *`)
    .bind(now + LEASE, crypto.randomUUID(), id, now, now - GRACE, MAX_ATTEMPTS, now).first<Reminder>();
}

export async function runReminders(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // Bounded maintenance also runs when sending is disabled. Pending jobs expire rather than accumulate forever.
  await env.DB.prepare(`UPDATE reminders SET status = CASE WHEN attempts > 0 THEN 'unknown' ELSE 'expired' END,
    finished_at = ?, last_error = 'deadline_or_attempt_limit'
    WHERE id IN (SELECT id FROM reminders WHERE status IN ('pending', 'sending')
      AND lease_until <= ? AND (due_at < ? OR attempts >= ?) LIMIT 100)`)
    .bind(now, now, now - GRACE, MAX_ATTEMPTS).run();
  await env.DB.prepare("DELETE FROM reminders WHERE id IN (SELECT id FROM reminders WHERE finished_at < ? LIMIT 100)")
    .bind(now - 30 * 86400).run();
  if (env.NOTIFY_ENABLED !== "true") return;
  const due = await env.DB.prepare(`SELECT id FROM reminders WHERE due_at <= ? AND due_at >= ? AND attempts < ?
    AND (status = 'pending' OR (status = 'sending' AND lease_until <= ?)) ORDER BY due_at, id LIMIT ?`)
    .bind(now, now - GRACE, MAX_ATTEMPTS, now, BATCH).all<{ id: number }>();

  for (const { id } of due.results) {
    try {
      const startedAt = Math.floor(Date.now() / 1000);
      const reminder = await claimReminder(env.DB, id, startedAt);
      if (!reminder) continue;
      const body = reminder.push_body ?? JSON.stringify({
        to: reminder.destination,
        messages: [{ type: "text", text: `Knot 提醒 #${id}\n${reminder.text}\n原訂：${reminderTime(reminder.due_at)}${startedAt - reminder.due_at >= 60 ? "\n此提醒延遲補發。" : ""}` }],
      });
      const persisted = await env.DB.prepare(`UPDATE reminders SET push_body = COALESCE(push_body, ?)
        WHERE id = ? AND status = 'sending' AND lease_token = ? RETURNING push_body`)
        .bind(body, id, reminder.lease_token).first<{ push_body: string }>();
      if (!persisted) continue;
      const result = await push(env.LINE_CHANNEL_ACCESS_TOKEN, persisted.push_body, reminder.retry_key);
      const finishedAt = Math.floor(Date.now() / 1000);
      const uncertain = reminder.uncertain || result.uncertain;
      const retry = !result.accepted && result.retryable && reminder.attempts < MAX_ATTEMPTS && finishedAt < reminder.due_at + GRACE;
      const status = result.accepted ? "accepted" : retry ? "sending" : uncertain ? "unknown" : "failed";
      await env.DB.prepare(`UPDATE reminders SET status = ?, uncertain = ?, last_error = ?,
        lease_until = ?, finished_at = ? WHERE id = ? AND status = 'sending' AND lease_token = ?`)
        .bind(status, Number(Boolean(uncertain)), result.accepted ? null : result.code,
          retry ? finishedAt + Math.min(60 * 2 ** (reminder.attempts - 1), 900) : 0,
          retry ? null : finishedAt, id, reminder.lease_token).run();
      if (!result.accepted) console.warn(JSON.stringify({ event: "reminder_push", id, status, code: result.code }));
    } catch {
      // A write may fail after LINE accepts. The lease makes the job recoverable with the SAME key/body.
      console.error(JSON.stringify({ event: "reminder_processing_error", id }));
    }
  }
}

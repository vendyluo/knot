export interface ReminderControl {
  paused: number;
  revision: number;
  changed_at: number | null;
  last_tick_started_at: number | null;
  last_tick_finished_at: number | null;
  last_tick_status: "running" | "completed" | "error" | null;
}

export async function getReminderControl(db: D1Database): Promise<ReminderControl> {
  const control = await db.prepare("SELECT * FROM reminder_control WHERE id = 1").first<ReminderControl>();
  if (!control) throw new Error("Missing reminder control migration");
  return control;
}

export async function setReminderPaused(db: D1Database, paused: boolean, revision: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE reminder_control SET paused = ?, revision = revision + 1, changed_at = ?
    WHERE id = 1 AND revision = ? RETURNING id`)
    .bind(Number(paused), Math.floor(Date.now() / 1000), revision).first();
  return result !== null;
}

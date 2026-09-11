import type { Env, LineEvent, Snapshot, Source } from "./types";

const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
const MEDIA_TYPES = new Set(["image", "video", "audio", "file"]);

export function workspaceKey(source: Source): string {
  switch (source.type) {
    case "user":
      return `user:${source.userId}`;
    case "group":
      return `group:${source.groupId}`;
    case "room":
      return `room:${source.roomId}`;
  }
}

export function sourceUserId(source: Source): string | null {
  return source.userId ?? null;
}

function keyPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

export async function recordEvent(env: Env, event: LineEvent): Promise<Snapshot | null> {
  if (event.type !== "message" || !event.message) return null;

  const workspace = workspaceKey(event.source);
  const eventKey = `temp/events/${keyPart(workspace)}/${event.message.id}.json`;
  const receivedAt = Math.floor(Date.now() / 1000);
  const expiresAt = receivedAt + SNAPSHOT_TTL_SECONDS;

  await env.BUCKET.put(eventKey, JSON.stringify(event), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt: String(expiresAt) },
  });

  await env.DB.prepare(
    `INSERT INTO snapshots (
      message_id, workspace_key, source_type, source_user_id, event_key,
      received_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      event_key = excluded.event_key,
      received_at = excluded.received_at,
      expires_at = excluded.expires_at`,
  )
    .bind(
      event.message.id,
      workspace,
      event.source.type,
      sourceUserId(event.source),
      eventKey,
      receivedAt,
      expiresAt,
    )
    .run();

  return {
    message_id: event.message.id,
    workspace_key: workspace,
    source_type: event.source.type,
    source_user_id: sourceUserId(event.source),
    event_key: eventKey,
    media_key: null,
    media_content_type: null,
    file_name: event.message.fileName ?? null,
    received_at: receivedAt,
    expires_at: expiresAt,
  };
}

export function isMediaEvent(event: LineEvent): boolean {
  return Boolean(event.message && MEDIA_TYPES.has(event.message.type));
}

export async function attachMedia(
  env: Env,
  snapshot: Snapshot,
  body: ReadableStream,
  contentType: string | null,
): Promise<void> {
  const mediaKey = `temp/media/${keyPart(snapshot.workspace_key)}/${snapshot.message_id}`;
  await env.BUCKET.put(mediaKey, body, {
    httpMetadata: contentType ? { contentType } : undefined,
    customMetadata: { expiresAt: String(snapshot.expires_at) },
  });
  await env.DB.prepare(
    "UPDATE snapshots SET media_key = ?, media_content_type = ? WHERE message_id = ?",
  )
    .bind(mediaKey, contentType, snapshot.message_id)
    .run();
}

export async function findSnapshot(env: Env, messageId: string, workspace: string): Promise<Snapshot | null> {
  return env.DB.prepare(
    "SELECT * FROM snapshots WHERE message_id = ? AND workspace_key = ? AND expires_at > ?",
  )
    .bind(messageId, workspace, Math.floor(Date.now() / 1000))
    .first<Snapshot>();
}

export async function recentSnapshots(
  env: Env,
  workspace: string,
  count: number,
  beforeMessageId: string,
): Promise<Snapshot[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM snapshots
     WHERE workspace_key = ? AND message_id != ? AND expires_at > ?
     ORDER BY received_at DESC LIMIT ?`,
  )
    .bind(workspace, beforeMessageId, Math.floor(Date.now() / 1000), count)
    .all<Snapshot>();
  return result.results.reverse();
}

async function readEvent(env: Env, snapshot: Snapshot): Promise<LineEvent> {
  const object = await env.BUCKET.get(snapshot.event_key);
  if (!object) throw new Error("Temporary event snapshot is no longer available");
  return object.json<LineEvent>();
}

export async function snapshotsReady(env: Env, snapshots: Snapshot[]): Promise<boolean> {
  for (const snapshot of snapshots) {
    const event = await readEvent(env, snapshot);
    if (isMediaEvent(event) && !snapshot.media_key) return false;
  }
  return true;
}

async function copyObject(env: Env, from: string, to: string): Promise<void> {
  const object = await env.BUCKET.get(from);
  if (!object) throw new Error(`Temporary object is no longer available: ${from}`);
  await env.BUCKET.put(to, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  });
}

export async function createNote(
  env: Env,
  workspace: string,
  kind: "message" | "text" | "conversation",
  creator: string | null,
  snapshots: Snapshot[],
  textOverride?: string,
): Promise<number> {
  const createdAt = Math.floor(Date.now() / 1000);
  const noteResult = await env.DB.prepare(
    "INSERT INTO notes (workspace_key, kind, created_by, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(workspace, kind, creator, createdAt)
    .run();
  const noteId = Number(noteResult.meta.last_row_id);
  const createdKeys: string[] = [];

  try {
    for (const [position, snapshot] of snapshots.entries()) {
      const event = await readEvent(env, snapshot);
      const permanentBase = `permanent/${keyPart(workspace)}/${noteId}/${position}`;
      const eventKey = `${permanentBase}/event.json`;
      await copyObject(env, snapshot.event_key, eventKey);
      createdKeys.push(eventKey);

      const itemResult = await env.DB.prepare(
        `INSERT INTO note_items (
          note_id, source_message_id, source_user_id, position, kind, text, snapshot_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          noteId,
          snapshot.message_id,
          snapshot.source_user_id,
          position,
          event.message?.type ?? "unknown",
          position === 0 && textOverride !== undefined ? textOverride : event.message?.text ?? null,
          eventKey,
          Math.floor(event.timestamp / 1000),
        )
        .run();
      const itemId = Number(itemResult.meta.last_row_id);

      if (snapshot.media_key) {
        const mediaKey = `${permanentBase}/content`;
        await copyObject(env, snapshot.media_key, mediaKey);
        createdKeys.push(mediaKey);
        await env.DB.prepare(
          "INSERT INTO attachments (note_item_id, r2_key, content_type, file_name) VALUES (?, ?, ?, ?)",
        )
          .bind(itemId, mediaKey, snapshot.media_content_type, snapshot.file_name)
          .run();
      }
    }
    return noteId;
  } catch (error) {
    await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(noteId).run();
    await Promise.all(createdKeys.map((key) => env.BUCKET.delete(key)));
    throw error;
  }
}

export interface NoteSummary {
  id: number;
  kind: string;
  created_at: number;
  item_count: number;
  preview: string | null;
  primary_kind: string | null;
  attachment_count: number;
}

export interface NoteDetail {
  id: number;
  kind: string;
  items: Array<{ kind: string; text: string | null; position: number }>;
  attachments: Array<{
    id: number;
    r2_key: string;
    content_type: string | null;
    file_name: string | null;
  }>;
}

export interface StoredAttachment {
  r2_key: string;
  content_type: string | null;
  file_name: string | null;
}

export async function listNotes(env: Env, workspace: string): Promise<NoteSummary[]> {
  const result = await env.DB.prepare(
    `SELECT n.id, n.kind, n.created_at, COUNT(DISTINCT i.id) AS item_count,
            MIN(CASE WHEN i.text IS NOT NULL THEN substr(i.text, 1, 60) END) AS preview,
            (SELECT first_item.kind FROM note_items first_item
             WHERE first_item.note_id = n.id ORDER BY first_item.position LIMIT 1) AS primary_kind,
            COUNT(a.id) AS attachment_count
     FROM notes n
     LEFT JOIN note_items i ON i.note_id = n.id
     LEFT JOIN attachments a ON a.note_item_id = i.id
     WHERE n.workspace_key = ?
     GROUP BY n.id
     ORDER BY n.created_at DESC
     LIMIT 10`,
  )
    .bind(workspace)
    .all<NoteSummary>();
  return result.results;
}

export async function getNote(env: Env, workspace: string, noteId: number): Promise<NoteDetail | null> {
  const note = await env.DB.prepare("SELECT id, kind FROM notes WHERE id = ? AND workspace_key = ?")
    .bind(noteId, workspace)
    .first<{ id: number; kind: string }>();
  if (!note) return null;

  const [items, attachments] = await Promise.all([
    env.DB.prepare("SELECT kind, text, position FROM note_items WHERE note_id = ? ORDER BY position")
      .bind(noteId)
      .all<{ kind: string; text: string | null; position: number }>(),
    env.DB.prepare(
      `SELECT a.id, a.r2_key, a.content_type, a.file_name
       FROM attachments a JOIN note_items i ON i.id = a.note_item_id
       WHERE i.note_id = ? ORDER BY i.position, a.id`,
    )
      .bind(noteId)
      .all<{ id: number; r2_key: string; content_type: string | null; file_name: string | null }>(),
  ]);

  return { ...note, items: items.results, attachments: attachments.results };
}

export async function getAttachment(env: Env, attachmentId: number): Promise<StoredAttachment | null> {
  return env.DB.prepare("SELECT r2_key, content_type, file_name FROM attachments WHERE id = ?")
    .bind(attachmentId)
    .first<StoredAttachment>();
}

export async function deleteNote(env: Env, workspace: string, noteId: number): Promise<boolean> {
  const objects = await env.DB.prepare(
    `SELECT i.snapshot_key AS key FROM note_items i
     JOIN notes n ON n.id = i.note_id
     WHERE i.note_id = ? AND n.workspace_key = ?
     UNION ALL
     SELECT a.r2_key AS key FROM attachments a
     JOIN note_items i ON i.id = a.note_item_id
     JOIN notes n ON n.id = i.note_id
     WHERE i.note_id = ? AND n.workspace_key = ?`,
  )
    .bind(noteId, workspace, noteId, workspace)
    .all<{ key: string }>();

  const result = await env.DB.prepare("DELETE FROM notes WHERE id = ? AND workspace_key = ?")
    .bind(noteId, workspace)
    .run();
  if (!result.meta.changes) return false;

  await Promise.all(objects.results.map(({ key }) => env.BUCKET.delete(key)));
  return true;
}

export async function pruneExpiredSnapshotIndex(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM snapshots WHERE expires_at <= ?")
    .bind(Math.floor(Date.now() / 1000))
    .run();
}

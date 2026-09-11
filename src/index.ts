import { parseCommand } from "./commands";
import { createDownloadUrl, serveDownload } from "./downloads";
import { getMessageContent, reply, verifySignature } from "./line";
import { helpMessage, notesMessage, retrievedMessage, savedMessage, textMessage } from "./messages";
import {
  attachMedia,
  createNote,
  deleteNote,
  findSnapshot,
  getNote,
  isMediaEvent,
  listNotes,
  pruneExpiredSnapshotIndex,
  recentSnapshots,
  recordEvent,
  snapshotsReady,
  sourceUserId,
  workspaceKey,
} from "./storage";
import type { Env, LineEvent, LineReplyMessage, Snapshot, WebhookBody } from "./types";

async function replyTo(env: Env, event: LineEvent, message: LineReplyMessage): Promise<void> {
  if (event.replyToken) await reply(env.LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, message);
}

function snapshotKind(snapshot: Snapshot): string {
  const contentType = snapshot.media_content_type ?? "";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (snapshot.media_key) return "file";
  return "text";
}

async function handleCommand(env: Env, event: LineEvent, ownSnapshot: Snapshot, origin: string): Promise<void> {
  const message = event.message;
  if (!message?.text) return;
  const command = parseCommand(message.text);
  if (!command) return;

  const workspace = workspaceKey(event.source);
  const creator = sourceUserId(event.source);

  switch (command.type) {
    case "help":
      await replyTo(env, event, helpMessage());
      return;
    case "invalid":
      await replyTo(env, event, textMessage(`${command.reason}。`, true));
      return;
    case "save-text": {
      const id = await createNote(env, workspace, "text", creator, [ownSnapshot], { textOverride: command.text });
      await replyTo(env, event, savedMessage(id, "text"));
      return;
    }
    case "save-quoted": {
      if (!message.quotedMessageId) {
        await replyTo(env, event, textMessage("請先回覆想保存的訊息，再輸入 @memo。", true));
        return;
      }
      const quoted = await findSnapshot(env, message.quotedMessageId, workspace);
      if (!quoted) {
        await replyTo(
          env,
          event,
          textMessage("找不到這則訊息的短期快照。它可能已超過 24 小時，或 Knot 當時還不在聊天室。", true),
        );
        return;
      }
      if (!(await snapshotsReady(env, [quoted]))) {
        await replyTo(env, event, textMessage("附件還在安全下載中，請稍等幾秒再輸入一次 @memo。"));
        return;
      }
      const id = await createNote(env, workspace, "message", creator, [quoted], {
        description: command.description,
      });
      await replyTo(env, event, savedMessage(id, snapshotKind(quoted), { description: command.description }));
      return;
    }
    case "save-conversation": {
      const snapshots = await recentSnapshots(env, workspace, command.count, message.id);
      if (!snapshots.length) {
        await replyTo(env, event, textMessage("目前沒有可保存的短期對話快照。", true));
        return;
      }
      if (!(await snapshotsReady(env, snapshots))) {
        await replyTo(env, event, textMessage("最近對話中仍有附件正在安全下載，請稍等幾秒再試。"));
        return;
      }
      const id = await createNote(env, workspace, "conversation", creator, snapshots);
      await replyTo(env, event, savedMessage(id, "conversation", { itemCount: snapshots.length }));
      return;
    }
    case "list": {
      const notes = await listNotes(env, workspace);
      if (!notes.length) {
        await replyTo(env, event, textMessage("這個聊天室還沒有記事。回覆重要訊息並輸入 @memo，就能留下第一個結。", true));
        return;
      }
      await replyTo(env, event, notesMessage(notes));
      return;
    }
    case "retrieve": {
      const note = await getNote(env, workspace, command.id);
      if (!note) {
        await replyTo(env, event, textMessage(`找不到記事 #${command.id}。`, true));
        return;
      }
      const downloadUrls = await Promise.all(
        note.attachments.slice(0, 10).map((attachment) =>
          createDownloadUrl(origin, attachment.id, env.LINE_CHANNEL_SECRET),
        ),
      );
      await replyTo(env, event, retrievedMessage(note, downloadUrls));
      return;
    }
    case "delete": {
      const deleted = await deleteNote(env, workspace, command.id);
      await replyTo(
        env,
        event,
        textMessage(deleted ? `已刪除記事 #${command.id}，永久附件也一併移除了。` : `找不到記事 #${command.id}。`, !deleted),
      );
    }
  }
}

async function handleEvent(env: Env, event: LineEvent, ctx: ExecutionContext, origin: string): Promise<void> {
  const snapshot = await recordEvent(env, event);
  if (!snapshot) return;

  if (isMediaEvent(event)) {
    ctx.waitUntil(
      getMessageContent(env.LINE_CHANNEL_ACCESS_TOKEN, snapshot.message_id)
        .then((content) => attachMedia(env, snapshot, content.body, content.contentType))
        .catch((error) => console.error("Unable to snapshot LINE media", error)),
    );
  }

  await handleCommand(env, event, snapshot, origin);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const downloadMatch = request.method === "GET" && url.pathname.match(/^\/download\/(\d+)$/);
    if (downloadMatch) return serveDownload(request, env, Number(downloadMatch[1]));
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ name: "Knot", status: "ok" });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-line-signature");
    if (!signature || !(await verifySignature(rawBody, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody) as WebhookBody;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    for (const event of body.events) {
      await handleEvent(env, event, ctx, url.origin);
    }
    ctx.waitUntil(pruneExpiredSnapshotIndex(env));
    return new Response("OK");
  },
} satisfies ExportedHandler<Env>;

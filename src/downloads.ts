import { getAttachment } from "./storage";
import type { Env } from "./types";

const encoder = new TextEncoder();
const DOWNLOAD_TTL_SECONDS = 15 * 60;

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function signature(attachmentId: number, expiresAt: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(`${attachmentId}:${expiresAt}`)));
}

export async function createDownloadUrl(
  origin: string,
  attachmentId: number,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const expiresAt = now + DOWNLOAD_TTL_SECONDS;
  const token = await signature(attachmentId, expiresAt, secret);
  return `${origin}/download/${attachmentId}?expires=${expiresAt}&signature=${encodeURIComponent(token)}`;
}

function safeFileName(fileName: string | null, contentType: string | null): { ascii: string; encoded: string } {
  let name: string;
  if (fileName) {
    const cleaned = fileName.replace(/[\\/\r\n"]/g, "_").trim();
    if (cleaned) name = cleaned;
    else name = "";
  } else {
    name = "";
  }
  if (!name) {
    const extension = contentType?.split("/")[1]?.split(";")[0]?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
    name = `knot-attachment.${extension}`;
  }
  const ascii = name.replace(/[^\x20-\x7E]/g, "_");
  return { ascii, encoded: encodeURIComponent(name) };
}

export async function serveDownload(request: Request, env: Env, attachmentId: number): Promise<Response> {
  const url = new URL(request.url);
  const expiresAt = Number(url.searchParams.get("expires"));
  const provided = url.searchParams.get("signature") ?? "";
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + DOWNLOAD_TTL_SECONDS) {
    return new Response("Download link expired", { status: 403 });
  }
  const expected = await signature(attachmentId, expiresAt, env.LINE_CHANNEL_SECRET);
  if (provided.length !== expected.length) return new Response("Invalid download link", { status: 403 });
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  if (difference !== 0) return new Response("Invalid download link", { status: 403 });

  const attachment = await getAttachment(env, attachmentId);
  if (!attachment) return new Response("Attachment not found", { status: 404 });
  const object = await env.BUCKET.get(attachment.r2_key);
  if (!object) return new Response("Attachment not found", { status: 404 });

  const fileName = safeFileName(attachment.file_name, attachment.content_type);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${fileName.ascii}"; filename*=UTF-8''${fileName.encoded}`,
    "X-Content-Type-Options": "nosniff",
  });
  if (attachment.content_type) headers.set("Content-Type", attachment.content_type);
  if (object.size !== undefined) headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

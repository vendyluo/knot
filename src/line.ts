import type { LineReplyMessage } from "./types";

const encoder = new TextEncoder();

export async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  let expected: Uint8Array;
  try {
    expected = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0));
  } catch {
    return false;
  }

  if (digest.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < digest.length; index += 1) {
    difference |= digest[index] ^ expected[index];
  }
  return difference === 0;
}

export async function reply(
  accessToken: string,
  replyToken: string,
  messages: LineReplyMessage | LineReplyMessage[],
): Promise<void> {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages: Array.isArray(messages) ? messages : [messages] }),
  });

  if (!response.ok) {
    throw new Error(`LINE reply failed (${response.status}): ${await response.text()}`);
  }
}

export async function getMessageContent(
  accessToken: string,
  messageId: string,
): Promise<{ body: ReadableStream; contentType: string | null }> {
  const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok || !response.body) {
    throw new Error(`LINE content download failed (${response.status}): ${await response.text()}`);
  }

  return { body: response.body, contentType: response.headers.get("content-type") };
}

export async function push(accessToken: string, body: string, retryKey: string): Promise<{
  accepted: boolean; retryable: boolean; uncertain: boolean; code: string;
}> {
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Line-Retry-Key": retryKey,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const accepted = response.ok || (response.status === 409 && response.headers.has("x-line-accepted-request-id"));
    await response.body?.cancel();
    return { accepted, retryable: response.status >= 500, uncertain: response.status >= 500, code: `http_${response.status}` };
  } catch {
    // Never log response bodies, destinations, message content or credentials.
    return { accepted: false, retryable: true, uncertain: true, code: "network_timeout" };
  }
}

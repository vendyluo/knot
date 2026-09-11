export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
}

export type LineReplyMessage =
  | { type: "text"; text: string; quickReply?: LineQuickReply }
  | { type: "flex"; altText: string; contents: Record<string, unknown>; quickReply?: LineQuickReply };

interface LineQuickReply {
  items: Array<{
    type: "action";
    action: { type: "message"; label: string; text: string };
  }>;
}

export type Source =
  | { type: "user"; userId: string }
  | { type: "group"; groupId: string; userId?: string }
  | { type: "room"; roomId: string; userId?: string };

export interface LineMessage {
  id: string;
  type: string;
  text?: string;
  quotedMessageId?: string;
  fileName?: string;
}

export interface LineEvent {
  type: string;
  timestamp: number;
  source: Source;
  replyToken?: string;
  message?: LineMessage;
}

export interface WebhookBody {
  destination: string;
  events: LineEvent[];
}

export interface Snapshot {
  message_id: string;
  workspace_key: string;
  source_type: string;
  source_user_id: string | null;
  event_key: string;
  media_key: string | null;
  media_content_type: string | null;
  file_name: string | null;
  received_at: number;
  expires_at: number;
}

export type Command =
  | { type: "save-quoted"; description?: string }
  | { type: "save-text"; text: string }
  | { type: "save-conversation"; count: number }
  | { type: "list" }
  | { type: "retrieve"; id: number }
  | { type: "delete"; id: number }
  | { type: "help" }
  | { type: "invalid"; reason: string };

const MAX_CONVERSATION_MESSAGES = 50;
const MAX_DESCRIPTION_LENGTH = 200;

export function parseCommand(text: string): Command | null {
  const input = text.trim();
  const match = input.match(/^[@#]memo(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const argument = match[1]?.trim();
  if (!argument) return { type: "save-quoted" };

  if (/^(help|說明)$/i.test(argument)) return { type: "help" };
  if (/^(list|列表)$/i.test(argument)) return { type: "list" };

  const textMatch = argument.match(/^(?:text|文字)\s+([\s\S]+)$/i);
  if (textMatch) return { type: "save-text", text: textMatch[1].trim() };

  const conversationMatch = argument.match(/^(?:chat|conversation|對話)(?:\s+(\d+))?$/i);
  if (conversationMatch) {
    const count = Number(conversationMatch[1] ?? 10);
    if (count < 1 || count > MAX_CONVERSATION_MESSAGES) {
      return { type: "invalid", reason: `對話則數必須介於 1–${MAX_CONVERSATION_MESSAGES}` };
    }
    return { type: "save-conversation", count };
  }

  const deleteMatch = argument.match(/^(?:delete|刪除)\s+(\d+)$/i);
  if (deleteMatch) return { type: "delete", id: Number(deleteMatch[1]) };

  const retrieveMatch = argument.match(/^(?:get|retrieve|取出)\s+(\d+)$/i);
  if (retrieveMatch) return { type: "retrieve", id: Number(retrieveMatch[1]) };

  const description = argument.replace(/^(?:save|存)\s+/i, "").trim();
  if (Array.from(description).length > MAX_DESCRIPTION_LENGTH) {
    return { type: "invalid", reason: `描述最多 ${MAX_DESCRIPTION_LENGTH} 個字` };
  }
  return { type: "save-quoted", description };
}

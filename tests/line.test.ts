import { afterEach, describe, expect, it, vi } from "vitest";
import { reply, verifySignature } from "../src/line";

afterEach(() => vi.restoreAllMocks());

describe("verifySignature", () => {
  it("accepts the independently calculated HMAC-SHA256 signature", async () => {
    expect(
      await verifySignature(
        "The quick brown fox jumps over the lazy dog",
        "97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=",
        "key",
      ),
    ).toBe(true);
  });

  it("rejects changed content and malformed base64", async () => {
    const signature = "97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=";
    expect(await verifySignature("changed", signature, "key")).toBe(false);
    expect(await verifySignature("body", "%not-base64%", "key")).toBe(false);
  });

  it("sends a structured Flex message through the Reply API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const message = {
      type: "flex" as const,
      altText: "Saved",
      contents: { type: "bubble" },
    };

    await reply("access-token", "reply-token", message);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(JSON.parse(String(init?.body))).toEqual({ replyToken: "reply-token", messages: [message] });
  });
});

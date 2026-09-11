import { describe, expect, it } from "vitest";
import { createDownloadUrl, serveDownload } from "../src/downloads";
import type { Env } from "../src/types";

function testEnv(): Env {
  return {
    LINE_CHANNEL_SECRET: "download-secret",
    LINE_CHANNEL_ACCESS_TOKEN: "unused",
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            r2_key: "permanent/test/content",
            content_type: "video/mp4",
            file_name: "北海道 旅行.mp4",
          }),
        }),
      }),
    } as unknown as D1Database,
    BUCKET: {
      get: async () => ({ body: "video", size: 5 }),
    } as unknown as R2Bucket,
  };
}

describe("signed attachment downloads", () => {
  it("serves a valid link as a private download with a Unicode filename", async () => {
    const url = await createDownloadUrl("https://knot.example", 4, "download-secret");
    const response = await serveDownload(new Request(url), testEnv(), 4);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("video");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(response.headers.get("content-disposition")).toContain("%E5%8C%97%E6%B5%B7%E9%81%93");
  });

  it("rejects expired and tampered links before reading storage", async () => {
    const expired = new Request("https://knot.example/download/4?expires=1&signature=anything");
    expect((await serveDownload(expired, testEnv(), 4)).status).toBe(403);

    const validUrl = new URL(await createDownloadUrl("https://knot.example", 4, "download-secret"));
    validUrl.searchParams.set("signature", `x${validUrl.searchParams.get("signature")}`);
    expect((await serveDownload(new Request(validUrl), testEnv(), 4)).status).toBe(403);
  });
});

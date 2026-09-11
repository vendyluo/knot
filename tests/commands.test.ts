import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands";

describe("parseCommand", () => {
  it("ignores ordinary chat", () => {
    expect(parseCommand("晚餐吃什麼？")).toBeNull();
  });

  it("treats bare @memo as saving a quoted message", () => {
    expect(parseCommand(" @memo ")).toEqual({ type: "save-quoted" });
  });

  it("preserves multi-line text after an explicit text command", () => {
    expect(parseCommand("@memo 文字 10/3 入住\n記得帶護照")).toEqual({
      type: "save-text",
      text: "10/3 入住\n記得帶護照",
    });
  });

  it("supports deterministic English and Chinese aliases", () => {
    expect(parseCommand("@memo list")).toEqual({ type: "list" });
    expect(parseCommand("@memo 刪除 42")).toEqual({ type: "delete", id: 42 });
    expect(parseCommand("@memo chat 12")).toEqual({ type: "save-conversation", count: 12 });
    expect(parseCommand("#memo 取出 42")).toEqual({ type: "retrieve", id: 42 });
    expect(parseCommand("@memo get 7")).toEqual({ type: "retrieve", id: 7 });
  });

  it("defaults conversations to 10 and rejects oversized ranges", () => {
    expect(parseCommand("@memo 對話")).toEqual({ type: "save-conversation", count: 10 });
    expect(parseCommand("@memo 對話 51")).toEqual({
      type: "invalid",
      reason: "對話則數必須介於 1–50",
    });
  });
});

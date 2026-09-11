import { describe, expect, it } from "vitest";
import { sourceUserId, workspaceKey } from "../src/storage";

describe("LINE source mapping", () => {
  it("keeps personal and group data in separate workspaces", () => {
    expect(workspaceKey({ type: "user", userId: "U123" })).toBe("user:U123");
    expect(workspaceKey({ type: "group", groupId: "C456", userId: "U123" })).toBe("group:C456");
  });

  it("retains the author independently from the workspace", () => {
    expect(sourceUserId({ type: "group", groupId: "C456", userId: "U123" })).toBe("U123");
    expect(sourceUserId({ type: "room", roomId: "R789" })).toBeNull();
  });
});

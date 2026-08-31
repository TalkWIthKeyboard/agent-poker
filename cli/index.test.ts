import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("poker CLI", () => {
  it("initializes the WebSocket client before running", () => {
    const result = spawnSync("bun", ["cli/index.ts", "status", "--server", "http://127.0.0.1:1"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not connect");
    expect(result.stderr).not.toContain("before initialization");
  });
});

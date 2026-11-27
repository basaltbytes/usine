import { describe, expect, it } from "@effect/vitest";
import {
  MCP_RECONNECT_MS,
  nextReconnectDelay,
} from "../../src/harness/opencode/bridge/reconnect.ts";

describe("OpenCode bridge reconnection", () => {
  it("doubles the wait from 500 ms up to 10 seconds", () => {
    const delays = [MCP_RECONNECT_MS];
    for (let index = 0; index < 6; index++)
      delays.push(nextReconnectDelay(delays[delays.length - 1] ?? 0));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  });
});

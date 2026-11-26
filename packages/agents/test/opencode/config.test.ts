import { describe, expect, it } from "@effect/vitest";
import { serveEnvironment } from "../../src/harness/opencode/config.ts";

describe("OpenCode serve environment", () => {
  it("keeps serve's database in the session's data directory, and the worker's for its commands", () => {
    const environment = serveEnvironment(
      { OPENCODE_DB: "/shared/opencode.db", XDG_DATA_HOME: "/home/worker/.local/share" },
      "/attempt/opencode/child_1",
      "{}",
    );
    expect(environment).toMatchObject({
      OPENCODE_DB: "/shared/opencode.db",
      XDG_DATA_HOME: "/home/worker/.local/share",
      USINE_OPENCODE_SERVE_OPENCODE_DB: "/attempt/opencode/child_1/opencode/opencode.db",
      USINE_OPENCODE_SERVE_XDG_DATA_HOME: "/attempt/opencode/child_1",
    });
  });
});

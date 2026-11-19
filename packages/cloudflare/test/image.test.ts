import { Effect, Clock, Duration, Config, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DRAIN_MARKER, SANDBOX_HOME } from "../src/api/harness.ts";

const dockerfile = readFileSync(new URL("../image/Dockerfile", import.meta.url), "utf8");

describe("sandbox image", () => {
  it.live("records the platform's SIGTERM in the drain marker and keeps running", () =>
    Effect.gen(function* () {
      const actual1 = yield* Config.option(Config.String("PATH"));
      const environmentPATH1 = Option.getOrUndefined(actual1);
      expect(DRAIN_MARKER).toBe(`${SANDBOX_HOME}/.usine/draining`);
      expect(dockerfile).toContain(`ENV HOME=${SANDBOX_HOME}`);
      expect(dockerfile).toContain('CMD ["/usr/local/bin/usine-sandbox-init"]');
      const home = mkdtempSync(join(tmpdir(), "usine-sandbox-init-"));
      const marker = join(home, ".usine", "draining");
      const init = spawn("sh", [fileURLToPath(new URL("../image/init.sh", import.meta.url))], {
        env: { PATH: environmentPATH1 ?? "/usr/bin:/bin", HOME: home },
        stdio: "ignore",
      });
      try {
        yield* Clock.Clock.defaultValue().sleep(Duration.millis(300));
        init.kill("SIGTERM");
        for (let waited = 0; waited < 5_000 && !existsSync(marker); waited += 50)
          yield* Clock.Clock.defaultValue().sleep(Duration.millis(50));

        expect(readFileSync(marker, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n$/u);
        expect(init.exitCode).toBeNull();
        expect(init.signalCode).toBeNull();
      } finally {
        init.kill("SIGKILL");
      }
    }),
  );
});

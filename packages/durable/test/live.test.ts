import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

it.each(["node", "custom", "environment"])(
  "opens the live harness with one proxy-aware dispatcher (%s fetch/environment)",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "usine-http-dispatcher-"));
    try {
      await promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(new URL("./fixtures/http-dispatcher.ts", import.meta.url)),
          directory,
          scenario,
        ],
        {
          timeout: 20_000,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: join(directory, "pi"),
            PI_OFFLINE: "1",
            HTTP_PROXY: undefined,
            HTTPS_PROXY: undefined,
            http_proxy: undefined,
            https_proxy: undefined,
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
          },
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { Predicate } from "effect";
import { ADMIN_TOKEN_VALUE } from "./fixtures.ts";

const MAIN = fileURLToPath(new URL("../src/node/main.ts", import.meta.url));

/** Returns a loopback port that's free at the time of the call. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address !== null && !Predicate.isString(address)
          ? resolve(address.port)
          : reject(new Error("the probe server has no port")),
      );
    });
  });

describe("the usine-gateway command", () => {
  it("exits 0 once its servers are closed when SIGTERM stops it", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-gateway-main-"));
    try {
      const allowlist = join(directory, "egress-allowlist");
      await writeFile(allowlist, "registry.npmjs.org\n");
      const gateway = spawn(process.execPath, ["--experimental-strip-types", MAIN], {
        env: {
          PATH: process.env.PATH ?? "",
          USINE_GATEWAY_DOMAIN: "gw.test",
          USINE_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN_VALUE,
          USINE_GATEWAY_CALLER_KEY: "caller-key-for-the-command-0123456789",
          USINE_GATEWAY_EGRESS_ALLOWLIST: allowlist,
          USINE_GATEWAY_PROXY_PORT: String(await freePort()),
          USINE_GATEWAY_EGRESS_PORT: String(await freePort()),
          USINE_GATEWAY_ADMIN_PORT: String(await freePort()),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const exited = new Promise<number | null>((resolve) =>
        gateway.once("exit", (code) => resolve(code)),
      );
      await new Promise<void>((resolve, reject) => {
        const read = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("The gateway admin API is listening")) resolve();
        };
        gateway.stdout.on("data", read);
        gateway.stderr.on("data", read);
        gateway.once("exit", () => reject(new Error(`usine-gateway exited first:\n${output}`)));
      });
      gateway.kill("SIGTERM");
      assert.strictEqual(await exited, 0, output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

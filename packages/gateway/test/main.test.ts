import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { ADMIN_TOKEN_VALUE, freeGatewayPorts } from "./fixtures.ts";

const MAIN = fileURLToPath(new URL("../src/node/main.ts", import.meta.url));

/** Starts `usine-gateway` on free ports and waits until its admin API listens or it exits. */
const start = async (env: Readonly<Record<string, string>>) => {
  const ports = await Effect.runPromise(freeGatewayPorts);
  const gateway = spawn(process.execPath, ["--experimental-strip-types", MAIN], {
    env: {
      ...env,
      USINE_GATEWAY_PROXY_PORT: String(ports.proxy),
      USINE_GATEWAY_EGRESS_PORT: String(ports.egress),
      USINE_GATEWAY_ADMIN_PORT: String(ports.admin),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise<number | null>((resolve) =>
    gateway.once("exit", (code) => resolve(code)),
  );
  const listening = await new Promise<boolean>((resolve) => {
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("The gateway admin API is listening")) resolve(true);
    };
    gateway.stdout.on("data", read);
    gateway.stderr.on("data", read);
    // Unlike `exit`, `close` waits for the output streams to end.
    gateway.once("close", () => resolve(false));
  });
  return { gateway, exited, listening, output: () => output };
};

describe("the usine-gateway command", () => {
  it("exits 0 once its servers are closed when SIGTERM stops it", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "usine-gateway-main-"));
    try {
      const allowlist = join(directory, "egress-allowlist");
      await writeFile(allowlist, "registry.npmjs.org\n");
      const environment = {
        PATH: process.env.PATH ?? "",
        USINE_GATEWAY_DOMAIN: "gw.test",
        USINE_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN_VALUE,
        USINE_GATEWAY_CALLER_KEY: "caller-key-for-the-command-0123456789",
        USINE_GATEWAY_EGRESS_ALLOWLIST: allowlist,
      };
      let started = await start(environment);
      // Another test file can bind a probed port before the command does.
      for (let retry = 0; retry < 3; retry++) {
        if (started.listening || !started.output().includes("EADDRINUSE")) break;
        started = await start(environment);
      }
      assert.isTrue(started.listening, `usine-gateway exited first:\n${started.output()}`);
      started.gateway.kill("SIGTERM");
      assert.strictEqual(await started.exited, 0, started.output());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

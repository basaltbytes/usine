import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Redacted, Schema } from "effect";
import { Attached } from "../src/admin/api.ts";
import { silentTunnel } from "./tunnel.ts";
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
  return { gateway, exited, listening, ports, output: () => output };
};

const stop = async (started: Awaited<ReturnType<typeof start>>) => {
  const timer = setTimeout(() => started.gateway.kill("SIGKILL"), 3000);
  started.gateway.kill("SIGTERM");
  try {
    assert.strictEqual(await started.exited, 0, started.output());
  } finally {
    clearTimeout(timer);
  }
};

const partialRequest = (port: number) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write("GET / HTTP/1.1\r\nHost: gw.test\r\n");
      resolve(socket);
    });
    socket.on("error", reject);
  });

describe("the usine-gateway command", () => {
  it(
    "exits within three seconds on SIGTERM with partial HTTP requests and a CONNECT tunnel",
    { timeout: 30_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-gateway-main-"));
      try {
        const allowlist = join(directory, "egress-allowlist");
        await writeFile(allowlist, "registry.npmjs.org\n");
        const environment = {
          PATH: process.env.PATH ?? "",
          STATE_DIRECTORY: directory,
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
        const sockets: Array<Socket> = [];
        try {
          sockets.push(await partialRequest(started.ports.proxy));
          sockets.push(await partialRequest(started.ports.admin));
          sockets.push(
            await Effect.runPromise(
              silentTunnel({ host: "127.0.0.1", port: started.ports.egress }, "git.gw.test:80"),
            ),
          );
          await stop(started);
        } finally {
          for (const socket of sockets) socket.destroy();
          started.gateway.kill("SIGKILL");
          await started.exited;
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it(
    "accepts the original caller token immediately after a process restart and recreates missing attachments on renewal",
    { timeout: 30_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "usine-gateway-restart-"));
      const upstream = createServer((request, response) => {
        assert.strictEqual(request.headers.authorization, "Bearer sk-test-upstream");
        response.end("upstream accepted");
      });
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      const address = upstream.address();
      assert(address !== null && !Predicate.isString(address));
      const environment = {
        PATH: process.env.PATH ?? "",
        STATE_DIRECTORY: directory,
        USINE_GATEWAY_DOMAIN: "gw.test",
        USINE_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN_VALUE,
        USINE_GATEWAY_CALLER_KEY: "caller-key-for-the-command-0123456789",
        USINE_GATEWAY_EGRESS_ALLOWLIST: join(directory, "egress-allowlist"),
        OPENAI_API_KEY: "sk-test-upstream",
        USINE_GATEWAY_OPENAI_UPSTREAM: `http://127.0.0.1:${address.port}`,
      };
      await writeFile(environment.USINE_GATEWAY_EGRESS_ALLOWLIST, "registry.npmjs.org\n");
      let started = await start(environment);
      try {
        assert.isTrue(started.listening, started.output());
        const payload = JSON.stringify({
          worker: "worker",
          repository: "acme/demo",
          credential: { _tag: "InstallationCredential", token: "ghs_restart-secret" },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        const adminRequest = (path: string, method: string, body?: string) =>
          fetch(`http://127.0.0.1:${started.ports.admin}/v1/attachments${path}`, {
            method,
            body: body ?? null,
            headers: {
              authorization: `Bearer ${ADMIN_TOKEN_VALUE}`,
              "content-type": "application/json",
            },
          });
        const response = await adminRequest("", "POST", payload);
        assert.strictEqual(response.status, 200);
        const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Attached));
        const attached = decode(await response.json());
        const token = Redacted.value(attached.callerToken);
        const call = () =>
          new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
            const outgoing = request(
              {
                host: "127.0.0.1",
                port: started.ports.proxy,
                path: "/openai/v1/responses",
                method: "POST",
                headers: {
                  host: "llm.gw.test",
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
              },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                  body += chunk;
                });
                response.on("error", reject);
                response.on("end", () => resolve({ status: response.statusCode, body }));
              },
            );
            outgoing.on("error", reject);
            outgoing.end("{}");
          });
        const firstResponse = await call();
        assert.strictEqual(firstResponse.status, 200, firstResponse.body);
        assert.isFalse(
          (await readFile(join(directory, "attachments.enc"))).includes("ghs_restart-secret"),
        );
        started.gateway.kill("SIGKILL");
        await started.exited;
        started = await start(environment);
        assert.isTrue(started.listening, started.output());
        const afterRestart = await call();
        assert.strictEqual(afterRestart.status, 200);
        assert.strictEqual(afterRestart.body, "upstream accepted");
        const snapshot = join(directory, "attachments.enc");
        await rename(snapshot, `${snapshot}.saved`);
        await mkdir(snapshot);
        const rejected = await adminRequest(`/${attached.attachment.id}`, "PUT", payload);
        assert.strictEqual(rejected.status, 503);
        const diagnostic = await rejected.text();
        assert.include(diagnostic, "AttachmentPersistenceError");
        assert.notInclude(diagnostic, "ghs_restart-secret");
        assert.strictEqual((await call()).status, 200);
        await rm(snapshot, { recursive: true });
        await rename(`${snapshot}.saved`, snapshot);

        await stop(started);
        await rm(join(directory, "attachments.enc"));
        started = await start(environment);
        assert.isTrue(started.listening, started.output());
        assert.strictEqual((await call()).status, 403);
        const renewed = decode(
          await (await adminRequest(`/${attached.attachment.id}`, "PUT", payload)).json(),
        );
        assert.strictEqual(Redacted.value(renewed.callerToken), token);
        assert.strictEqual((await call()).status, 200);
        await adminRequest(`/${attached.attachment.id}`, "DELETE");
        await stop(started);
        started = await start(environment);
        assert.isTrue(started.listening, started.output());
        assert.strictEqual((await call()).status, 403);
        await stop(started);
      } finally {
        started.gateway.kill("SIGKILL");
        await started.exited;
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

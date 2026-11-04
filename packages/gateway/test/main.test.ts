import { FetchHttpClient } from "effect/http";
import { NodeFileSystem } from "@effect/platform-node";
import { webRequest } from "../../../tooling/test/http.mts";
import {
  Fiber,
  Effect,
  Predicate,
  Redacted,
  Schema,
  DateTime,
  Clock,
  Deferred,
  FileSystem,
  Config,
  Option,
  Layer,
} from "effect";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

import { Attached } from "../src/admin/api.ts";
import { silentTunnel } from "./tunnel.ts";
import { ADMIN_TOKEN_VALUE, freeGatewayPorts } from "./fixtures.ts";

const MAIN = fileURLToPath(new URL("../src/node/main.ts", import.meta.url));

/** Starts `usine-gateway` on free ports and waits until its admin API listens or it exits. */
const start = (env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const ports = yield* freeGatewayPorts;
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
    const exited = (() => {
      const completion = Deferred.makeUnsafe<number | null>();
      const resolve = (value: number | null) => {
        Deferred.doneUnsafe(completion, Effect.succeed(value));
      };
      gateway.once("exit", (code) => resolve(code));
      return Deferred.await(completion);
    })();
    const listening = yield* (() => {
      const completion = Deferred.makeUnsafe<boolean>();
      const resolve = (value: boolean) => {
        Deferred.doneUnsafe(completion, Effect.succeed(value));
      };
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("The gateway admin API is listening")) resolve(true);
      };
      gateway.stdout.on("data", read);
      gateway.stderr.on("data", read);
      // Unlike `exit`, `close` waits for the output streams to end.
      gateway.once("close", () => resolve(false));
      return Deferred.await(completion);
    })();
    return { gateway, exited, listening, ports, output: () => output };
  });

const stop = (started: Effect.Success<ReturnType<typeof start>>) =>
  Effect.gen(function* () {
    const timer = yield* Effect.sleep(3000).pipe(
      Effect.andThen(Effect.sync(() => started.gateway.kill("SIGKILL"))),
      Effect.forkScoped,
    );
    started.gateway.kill("SIGTERM");
    try {
      const actual6 = yield* started.exited;
      assert.strictEqual(actual6, 0, started.output());
    } finally {
      yield* Fiber.interrupt(timer);
    }
  });

const partialRequest = (port: number) =>
  (() => {
    const completion = Deferred.makeUnsafe<Socket>();
    const resolve = (value: Socket) => {
      Deferred.doneUnsafe(completion, Effect.succeed(value));
    };
    const reject = (error: Error) => {
      Deferred.doneUnsafe(completion, Effect.die(error));
    };
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write("GET / HTTP/1.1\r\nHost: gw.test\r\n");
      resolve(socket);
    });
    socket.on("error", reject);
    return Deferred.await(completion);
  })();

describe("the usine-gateway command", () => {
  it.live(
    "exits within three seconds on SIGTERM with partial HTTP requests and a CONNECT tunnel",
    () =>
      Effect.gen(function* () {
        const actual7 = yield* Config.option(Config.String("PATH"));
        const environmentPATH1 = Option.getOrUndefined(actual7);
        const directory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.makeTempDirectory({
            directory: dirname(join(tmpdir(), "usine-gateway-main-")),
            prefix: basename(join(tmpdir(), "usine-gateway-main-")),
          }),
        );
        try {
          const allowlist = join(directory, "egress-allowlist");
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.writeFileString(allowlist, "registry.npmjs.org\n"),
          );
          const environment = {
            PATH: environmentPATH1 ?? "",
            STATE_DIRECTORY: directory,
            USINE_GATEWAY_DOMAIN: "gw.test",
            USINE_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN_VALUE,
            USINE_GATEWAY_CALLER_KEY: "caller-key-for-the-command-0123456789",
            USINE_GATEWAY_EGRESS_ALLOWLIST: allowlist,
          };
          let started = yield* start(environment);
          // Another test file can bind a probed port before the command does.
          for (let retry = 0; retry < 3; retry++) {
            if (started.listening || !started.output().includes("EADDRINUSE")) break;
            started = yield* start(environment);
          }
          assert.isTrue(started.listening, `usine-gateway exited first:\n${started.output()}`);
          const sockets: Array<Socket> = [];
          try {
            const actual1 = yield* partialRequest(started.ports.proxy);
            sockets.push(actual1);
            const actual2 = yield* partialRequest(started.ports.admin);
            sockets.push(actual2);
            const actual3 = yield* silentTunnel(
              { host: "127.0.0.1", port: started.ports.egress },
              "git.gw.test:80",
            );
            sockets.push(actual3);
            yield* stop(started);
          } finally {
            for (const socket of sockets) socket.destroy();
            started.gateway.kill("SIGKILL");
            yield* started.exited;
          }
        } finally {
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.remove(directory, { recursive: true, force: true }),
          );
        }
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    { timeout: 30_000 },
  );

  it.live(
    "accepts the original caller token immediately after a process restart and recreates missing attachments on renewal",
    () =>
      Effect.gen(function* () {
        const actual8 = yield* Config.option(Config.String("PATH"));
        const environmentPATH2 = Option.getOrUndefined(actual8);
        const directory = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.makeTempDirectory({
            directory: dirname(join(tmpdir(), "usine-gateway-restart-")),
            prefix: basename(join(tmpdir(), "usine-gateway-restart-")),
          }),
        );
        const upstream = createServer((request, response) => {
          assert.strictEqual(request.headers.authorization, "Bearer sk-test-upstream");
          response.end("upstream accepted");
        });
        yield* Effect.callback<void>((resume) => {
          const resolve = (value: void) => resume(Effect.succeed(value));
          upstream.listen(0, "127.0.0.1", resolve);
        });
        const address = upstream.address();
        assert(address !== null && !Predicate.isString(address));
        const environment = {
          PATH: environmentPATH2 ?? "",
          STATE_DIRECTORY: directory,
          USINE_GATEWAY_DOMAIN: "gw.test",
          USINE_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN_VALUE,
          USINE_GATEWAY_CALLER_KEY: "caller-key-for-the-command-0123456789",
          USINE_GATEWAY_EGRESS_ALLOWLIST: join(directory, "egress-allowlist"),
          OPENAI_API_KEY: "sk-test-upstream",
          USINE_GATEWAY_OPENAI_UPSTREAM: `http://127.0.0.1:${address.port}`,
        };
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(
            environment.USINE_GATEWAY_EGRESS_ALLOWLIST,
            "registry.npmjs.org\n",
          ),
        );
        let started = yield* start(environment);
        try {
          assert.isTrue(started.listening, started.output());
          const json1 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            worker: "worker",
            repository: "acme/demo",
            credential: { _tag: "InstallationCredential", token: "ghs_restart-secret" },
            expiresAt: DateTime.formatIso(
              DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 3_600_000),
            ),
          }).pipe(Effect.orDie);
          const payload = json1;
          const adminRequest = (path: string, method: string, body?: string) =>
            webRequest(`http://127.0.0.1:${started.ports.admin}/v1/attachments${path}`, {
              method,
              body: body ?? null,
              headers: {
                authorization: `Bearer ${ADMIN_TOKEN_VALUE}`,
                "content-type": "application/json",
              },
            });
          const response = yield* adminRequest("", "POST", payload);
          assert.strictEqual(response.status, 200);
          const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(Attached));
          const actual4 = yield* Effect.promise(() => response.json());
          const attached = yield* decode(actual4);
          const token = Redacted.value(attached.callerToken);
          const call = () =>
            (() => {
              const completion = Deferred.makeUnsafe<{
                status: number | undefined;
                body: string;
              }>();
              const resolve = (value: { status: number | undefined; body: string }) => {
                Deferred.doneUnsafe(completion, Effect.succeed(value));
              };
              const reject = (error: Error) => {
                Deferred.doneUnsafe(completion, Effect.die(error));
              };
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
              return Deferred.await(completion);
            })();
          const firstResponse = yield* call();
          assert.strictEqual(firstResponse.status, 200, firstResponse.body);
          assert.isFalse(
            (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
              fileSystem.readFile(join(directory, "attachments.enc")).pipe(Effect.map(Buffer.from)),
            )).includes("ghs_restart-secret"),
          );
          started.gateway.kill("SIGKILL");
          yield* started.exited;
          started = yield* start(environment);
          assert.isTrue(started.listening, started.output());
          const afterRestart = yield* call();
          assert.strictEqual(afterRestart.status, 200);
          assert.strictEqual(afterRestart.body, "upstream accepted");
          const snapshot = join(directory, "attachments.enc");
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.rename(snapshot, `${snapshot}.saved`),
          );
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.makeDirectory(snapshot),
          );
          const rejected = yield* adminRequest(`/${attached.attachment.id}`, "PUT", payload);
          assert.strictEqual(rejected.status, 503);
          const diagnostic = yield* Effect.promise(() => rejected.text());
          assert.include(diagnostic, "AttachmentPersistenceError");
          assert.notInclude(diagnostic, "ghs_restart-secret");
          assert.strictEqual((yield* call()).status, 200);
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.remove(snapshot, { recursive: true }),
          );
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.rename(`${snapshot}.saved`, snapshot),
          );

          yield* stop(started);
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.remove(join(directory, "attachments.enc")),
          );
          started = yield* start(environment);
          assert.isTrue(started.listening, started.output());
          assert.strictEqual((yield* call()).status, 403);
          const renewedResponse = yield* adminRequest(`/${attached.attachment.id}`, "PUT", payload);
          const actual5 = yield* Effect.promise(() => renewedResponse.json());
          const renewed = yield* decode(actual5);
          assert.strictEqual(Redacted.value(renewed.callerToken), token);
          assert.strictEqual((yield* call()).status, 200);
          yield* adminRequest(`/${attached.attachment.id}`, "DELETE");
          yield* stop(started);
          started = yield* start(environment);
          assert.isTrue(started.listening, started.output());
          assert.strictEqual((yield* call()).status, 403);
          yield* stop(started);
        } finally {
          started.gateway.kill("SIGKILL");
          yield* started.exited;
          upstream.closeAllConnections();
          yield* Effect.callback<void>((resume) => {
            const resolve = (value: void) => resume(Effect.succeed(value));
            upstream.close(() => resolve());
          });
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.remove(directory, { recursive: true, force: true }),
          );
        }
      }).pipe(Effect.provide(Layer.provideMerge(NodeFileSystem.layer, FetchHttpClient.layer))),
    { timeout: 30_000 },
  );
});

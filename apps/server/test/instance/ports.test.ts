// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { type ChildProcess, spawn } from "node:child_process";
// This Node boundary needs synchronous filesystem operations that FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { type Server, createServer } from "node:net";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema, Deferred } from "effect";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { Port, SERVER_HOST } from "../../src/cli.ts";
import {
  ListeningPortsError,
  lsofListeningPorts,
  procListeningPorts,
} from "../../src/instance/ports.ts";
import { ProcessId } from "../../src/instance/record.ts";

const children: Array<ChildProcess> = [];
const servers: Array<Server> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) server.close();
});

const installed = (command: string) =>
  // The SDK test deliberately changes the host environment to verify tool isolation.
  // @effect-diagnostics-next-line processEnv:off
  (process.env.PATH ?? "").split(":").some((directory) => existsSync(join(directory, command)));

const PortAddress = Schema.Struct({ port: Port });

/** Listens on a free port in this process, which the lookup of another process must not list. */
const listenHere = () =>
  (() => {
    const completion = Deferred.makeUnsafe<Port>();
    const resolve = (value: Port) => {
      Deferred.doneUnsafe(completion, Effect.succeed(value));
    };
    const server = createServer();
    servers.push(server);
    server.listen({ host: SERVER_HOST, port: 0 }, () =>
      // Node event callbacks decode their arguments synchronously.
      // @effect-diagnostics-next-line schemaSync:off
      resolve(Schema.decodeUnknownSync(PortAddress)(server.address()).port),
    );
    return Deferred.await(completion);
  })();

/** Starts a process that listens on one free port, and returns its PID and port. */
const listeningChild = () =>
  (() => {
    const completion = Deferred.makeUnsafe<{ readonly pid: ProcessId; readonly port: Port }>();
    const resolve = (value: { readonly pid: ProcessId; readonly port: Port }) => {
      Deferred.doneUnsafe(completion, Effect.succeed(value));
    };
    const reject = (error: Error) => {
      Deferred.doneUnsafe(completion, Effect.die(error));
    };
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `require("node:net").createServer().listen(0, "${SERVER_HOST}", function () { console.log(this.address().port) })`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    children.push(child);
    child.once("error", reject);
    child.stdout.once("data", (data) =>
      resolve({
        // Node event callbacks decode their arguments synchronously.
        // @effect-diagnostics-next-line schemaSync:off
        pid: Schema.decodeUnknownSync(ProcessId)(child.pid),
        // Node event callbacks decode their arguments synchronously.
        // @effect-diagnostics-next-line schemaSync:off
        port: Schema.decodeSync(Port)(Number(String(data).trim())),
      }),
    );
    return Deferred.await(completion);
  })();

const lookups: ReadonlyArray<{
  readonly source: string;
  readonly lookup: (
    pid: ProcessId,
  ) => Effect.Effect<ReadonlyArray<Port>, ListeningPortsError, NodeServices.NodeServices>;
  readonly available: boolean;
}> = [
  { source: "/proc", lookup: procListeningPorts, available: process.platform === "linux" },
  { source: "lsof", lookup: lsofListeningPorts, available: installed("lsof") },
];

describe("listening ports", () => {
  for (const { source, lookup, available } of lookups) {
    it.live.skipIf(!available)(`lists the ports of the process alone, from ${source}`, () =>
      Effect.gen(function* () {
        yield* listenHere();
        const child = yield* listeningChild();
        const ports = yield* lookup(child.pid).pipe(Effect.provide(NodeServices.layer));
        assert.deepStrictEqual(ports, [child.port]);
      }),
    );
  }
});

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { afterEach, assert, describe, it } from "vitest";
import { Port, SERVER_HOST } from "../../src/cli.ts";
import { lsofListeningPorts, procListeningPorts } from "../../src/instance/ports.ts";
import { ProcessId } from "../../src/instance/record.ts";

const children: Array<ChildProcess> = [];
const servers: Array<Server> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) server.close();
});

const installed = (command: string) =>
  (process.env.PATH ?? "").split(":").some((directory) => existsSync(join(directory, command)));

const PortAddress = Schema.Struct({ port: Port });

/** Listens on a free port in this process, which the lookup of another process must not list. */
const listenHere = () =>
  new Promise<Port>((resolve) => {
    const server = createServer();
    servers.push(server);
    server.listen({ host: SERVER_HOST, port: 0 }, () =>
      resolve(Schema.decodeUnknownSync(PortAddress)(server.address()).port),
    );
  });

/** Starts a process that listens on one free port, and returns its PID and port. */
const listeningChild = () =>
  new Promise<{ readonly pid: ProcessId; readonly port: Port }>((resolve, reject) => {
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
        pid: Schema.decodeUnknownSync(ProcessId)(child.pid),
        port: Schema.decodeUnknownSync(Port)(Number(String(data).trim())),
      }),
    );
  });

const lookups: ReadonlyArray<{
  readonly source: string;
  readonly lookup: (
    pid: ProcessId,
  ) => Effect.Effect<ReadonlyArray<Port>, unknown, NodeServices.NodeServices>;
  readonly available: boolean;
}> = [
  { source: "/proc", lookup: procListeningPorts, available: process.platform === "linux" },
  { source: "lsof", lookup: lsofListeningPorts, available: installed("lsof") },
];

describe("listening ports", () => {
  for (const { source, lookup, available } of lookups) {
    it.skipIf(!available)(`lists the ports of the process alone, from ${source}`, async () => {
      await listenHere();
      const child = await listeningChild();
      const ports = await Effect.runPromise(
        lookup(child.pid).pipe(Effect.provide(NodeServices.layer)),
      );
      assert.deepStrictEqual(ports, [child.port]);
    });
  }
});

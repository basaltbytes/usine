import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { DateTime, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, assert, describe, it } from "vitest";
import { Port, SERVER_HOST } from "../src/cli.ts";
import { holdInstance } from "../src/instance/lock.ts";
import {
  InstanceLaunch,
  InstanceRecord,
  ProcessId,
  instanceFiles,
} from "../src/instance/record.ts";
import { OperatorApiError, listRuns } from "../src/instance/operator-api.ts";
import { status } from "../src/status.ts";

const folders: Array<string> = [];
const servers: Array<Server> = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const instanceFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-status-"));
  folders.push(folder);
  mkdirSync(join(folder, ".usine"));
  writeFileSync(join(folder, ".usine/admin-token"), "l".repeat(43), { mode: 0o600 });
  return InstanceDirectory.make(folder);
};

const PortAddress = Schema.Struct({ port: Port });

/** Serves `GET /api/overview` with `runs` on a free port, as a running instance would. */
const fakeOperatorApi = async (runs: ReadonlyArray<{ id: string; state: string }>) => {
  const server = createServer((request, response) => {
    if (request.url !== "/api/overview") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        _tag: "Ready",
        projects: [{ repository: "acme/widgets", runs }],
        loops: [],
        needsYou: [],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host: SERVER_HOST, port: 0 }, resolve));
  return Schema.decodeUnknownSync(PortAddress)(server.address()).port;
};

/** Returns a port that nothing listens on. */
const closedPort = async () => {
  const port = await fakeOperatorApi([]);
  const server = servers.pop();
  await new Promise((resolve) => server?.close(resolve));
  return port;
};

const recordFor = (port: Port) =>
  new InstanceRecord({
    pid: ProcessId.make(process.pid),
    version: "1.2.3",
    startedAt: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z"),
    launch: new InstanceLaunch({
      node: process.execPath,
      nodeOptions: [],
      script: "/opt/usine/apps/server/dist/main.js",
      port,
      logLevel: "Info",
      allowVolatileInstance: false,
    }),
  });

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const statusWhileHeld = (directory: InstanceDirectory, port: Port) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* holdInstance(directory, recordFor(port));
      return yield* status(directory);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

describe("usine status", () => {
  it("reports the pid, address, engine, start, and open runs of a running instance", async () => {
    const directory = instanceFolder();
    const port = await fakeOperatorApi([
      { id: "run-1", state: "Running" },
      { id: "run-2", state: "Queued" },
      { id: "run-3", state: "Queued" },
      { id: "run-4", state: "Succeeded" },
    ]);
    const report = await statusWhileHeld(directory, port);
    assert.isTrue(report.running);
    assert.strictEqual(report.lines[0], `usine is running in ${directory}.`);
    assert.include(report.lines, `  pid       ${process.pid}`);
    assert.include(report.lines, `  address   http://127.0.0.1:${port}`);
    assert.include(
      report.lines,
      "  engine    @usine/server 1.2.3, from /opt/usine/apps/server/dist/main.js",
    );
    assert.include(report.lines, "  runs      1 running, 2 queued");
    assert.match(report.lines.join("\n"), /started {3}2026-10-25T16:00:00\.000Z \(.+ ago\)/u);
    assert.notMatch(report.lines.join("\n"), /update/u, "an engine from a checkout has no pin");
  });

  it("says that the runs are unavailable when the operator API doesn't answer", async () => {
    const directory = instanceFolder();
    const port = await closedPort();
    const report = await statusWhileHeld(directory, port);
    assert.isTrue(report.running);
    assert.match(report.lines.join("\n"), /runs {6}unavailable: /u);
    const error = await Effect.runPromise(
      listRuns(port).pipe(Effect.flip, Effect.provide(services)),
    );
    assert.instanceOf(error, OperatorApiError);
    assert.strictEqual(error.url, `http://127.0.0.1:${port}/api/overview`);
  });

  it("reports a stopped instance and the stale files of one that crashed", async () => {
    const directory = instanceFolder();
    const clean = await Effect.runPromise(status(directory).pipe(Effect.provide(services)));
    assert.isFalse(clean.running);
    assert.deepStrictEqual(clean.lines, [`usine is not running in ${directory}.`]);

    const files = instanceFiles(directory);
    mkdirSync(files.folder, { recursive: true });
    writeFileSync(files.pid, "4242\n");
    const crashed = await Effect.runPromise(status(directory).pipe(Effect.provide(services)));
    assert.isFalse(crashed.running);
    assert.match(crashed.lines.join("\n"), /stale {5}pid 4242 in \.usine\/ exited/u);
  });
});

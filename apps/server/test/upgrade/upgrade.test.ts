import { sqliteTempDirectory } from "../../../../tooling/test/sqlite.mts";
// These fixtures use synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  // The synchronous fixture filesystem has no Effect FileSystem equivalent.
  // @effect-diagnostics-next-line nodeBuiltinImport:off
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { LifecycleOptions, Port, SERVER_HOST, UpgradeCommand } from "../../src/cli.ts";
import { CommandError, runCommand } from "../../src/command.ts";
import { startDetached } from "../../src/detach.ts";
import { requestSystemUpgrade } from "../../src/upgrade/client.ts";
import { InstanceRecord, ProcessId, InstanceLaunch } from "../../src/instance/record.ts";
import { probeInstance } from "../../src/instance/state.ts";
import { PackageLookupError, resolveVersion } from "../../src/registry.ts";
import { stop } from "../../src/stop.ts";
import { upgrade } from "../../src/upgrade/upgrade.ts";

// Pure serializers and synchronous callbacks return JSON values directly.
// @effect-diagnostics-next-line schemaSync:off
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const SCENARIO_TIMEOUT_MS = 60_000;
const FIXTURE = fileURLToPath(new URL("../fixtures/instance.mjs", import.meta.url));

// Answers `npm view` with version 2.0.0 and no dependencies, except for 9.9.9, which it doesn't
// have. Records `npm install`.
const FAKE_NPM = `#!/bin/sh
if [ "$1" = view ]; then
  [ "$2" = "@usine/server@9.9.9" ] && exit 0
  case "$3" in
    version) echo '"2.0.0"' ;;
    dependencies) echo '{}' ;;
  esac
  exit 0
fi
if [ "$1" = install ]; then
  echo install >> fake-npm.log
  exit 0
fi
exit 1
`;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "usine test",
  GIT_AUTHOR_EMAIL: "test@usine.invalid",
  GIT_COMMITTER_NAME: "usine test",
  GIT_COMMITTER_EMAIL: "test@usine.invalid",
};

const folders: Array<string> = [];
const pids = new Set<number>();
const originalEnvironment = { ...process.env };

beforeEach(() => {
  const bin = mkdtempSync(join(tmpdir(), "usine-fake-npm-"));
  folders.push(bin);
  writeFileSync(join(bin, "npm"), FAKE_NPM);
  chmodSync(join(bin, "npm"), 0o755);
  // Native command fixtures and test registration inspect the host environment synchronously.
  // @effect-diagnostics-next-line processEnv:off
  Object.assign(process.env, GIT_IDENTITY, { PATH: `${bin}${delimiter}${process.env.PATH}` });
});

afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process has exited.
    }
  }
  pids.clear();
  for (const key of Object.keys(process.env)) {
    // The SDK test deliberately changes the host environment to verify tool isolation.
    // @effect-diagnostics-next-line processEnv:off
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const PortAddress = Schema.Struct({ port: Port });

const freePort = () =>
  Effect.callback<Port>((resume) => {
    const resolve = (value: Port) => resume(Effect.succeed(value));
    const server = createServer();
    server.listen({ host: SERVER_HOST, port: 0 }, () => {
      // Node event callbacks decode their arguments synchronously.
      // @effect-diagnostics-next-line schemaSync:off
      const { port } = Schema.decodeUnknownSync(PortAddress)(server.address());
      server.close(() => resolve(port));
    });
  });

const services = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | HttpClient.HttpClient>,
) => effect.pipe(Effect.provide(services));

const options = LifecycleOptions.make({ timeout: Duration.seconds(20), force: false });

const git = (directory: string, ...args: ReadonlyArray<string>) =>
  spawnSync("git", args, { cwd: directory, encoding: "utf8" }).stdout.trim();

/** Creates an instance that pins @usine/server 1.0.0 and runs the fixture from its node_modules. */
const pinnedInstance = () =>
  Effect.gen(function* () {
    const directory = InstanceDirectory.make(
      mkdtempSync(join(sqliteTempDirectory(), "usine-upgrade-")),
    );
    folders.push(directory);
    writeFileSync(
      join(directory, "package.json"),
      `{\n  "name": "factory",\n  "dependencies": {\n    "@usine/server": "1.0.0"\n  }\n}\n`,
    );
    writeFileSync(join(directory, "package-lock.json"), "{}\n");
    writeFileSync(join(directory, ".gitignore"), ".usine/\nnode_modules/\nfake-npm.log\n");
    git(directory, "init", "--quiet");
    git(directory, "add", "-A");
    git(directory, "commit", "--quiet", "-m", "Create the instance");
    mkdirSync(join(directory, ".usine"));
    const store = new DatabaseSync(join(directory, ".usine", "runtime.sqlite"));
    store.exec("CREATE TABLE runs (id TEXT)");
    store.close();
    const engine = join(directory, "node_modules", "@usine", "server");
    mkdirSync(engine, { recursive: true });
    writeFileSync(
      join(engine, "main.mjs"),
      `import ${stringifyJson(pathToFileURL(FIXTURE).href)};\n`,
    );
    const launch = InstanceLaunch.make({
      node: process.execPath,
      nodeOptions: ["--experimental-strip-types", "--no-warnings"],
      script: join(engine, "main.mjs"),
      port: yield* freePort(),
      logLevel: "Info",
      allowVolatileInstance: false,
    });
    const { pid } = yield* run(startDetached(directory, launch, Duration.seconds(30)));
    pids.add(pid);
    return { directory, pid };
  });

const latest = UpgradeCommand.make({ version: Option.none(), check: false, options });

describe("usine upgrade", { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it.live(
    "backs up the stores, moves and commits the pin, installs, and restarts the instance",
    () =>
      Effect.gen(function* () {
        const { directory, pid } = yield* pinnedInstance();

        yield* upgrade(directory, latest).pipe(Effect.provide(services));

        assert.include(
          readFileSync(join(directory, "package.json"), "utf8"),
          '"@usine/server": "2.0.0"',
        );
        assert.strictEqual(readFileSync(join(directory, "fake-npm.log"), "utf8"), "install\n");
        assert.strictEqual(
          git(directory, "log", "-1", "--format=%s"),
          "Pin @usine/server to 2.0.0",
        );
        assert.strictEqual(git(directory, "status", "--porcelain"), "");
        const backups = readdirSync(join(directory, ".usine", "backups"));
        assert.lengthOf(backups, 1);
        assert.match(backups[0] ?? "", /^runtime-\d{8}T\d{6}Z-0\.0\.0-fixture\.sqlite$/u);
        const state = yield* probeInstance(directory).pipe(Effect.provide(services));
        assert(state._tag === "Running");
        pids.add(state.record.pid);
        assert.notStrictEqual(state.record.pid, pid);
        yield* stop(directory, options).pipe(Effect.provide(services));
      }),
  );

  it.live("leaves the pin and the instance alone while a run has a live attempt", () =>
    Effect.gen(function* () {
      const { directory, pid } = yield* pinnedInstance();
      const json1 = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
        { id: "run-live", state: "Running" },
      ]).pipe(Effect.orDie);
      writeFileSync(join(directory, "fixture-runs.json"), json1);

      const refused = yield* upgrade(directory, latest).pipe(Effect.flip, Effect.provide(services));

      assert(refused._tag === "LiveAttemptsError");
      assert.strictEqual(refused.command, "upgrade");
      assert.include(
        readFileSync(join(directory, "package.json"), "utf8"),
        '"@usine/server": "1.0.0"',
      );
      const state = yield* probeInstance(directory).pipe(Effect.provide(services));
      assert(state._tag === "Running");
      assert.strictEqual(state.record.pid, pid);
      yield* stop(directory, options).pipe(Effect.provide(services));
    }),
  );

  it.live("names the checkout that a running engine comes from instead of moving a pin", () =>
    Effect.gen(function* () {
      const directory = InstanceDirectory.make(
        mkdtempSync(join(sqliteTempDirectory(), "usine-upgrade-")),
      );
      folders.push(directory);
      const launch = InstanceLaunch.make({
        node: process.execPath,
        nodeOptions: ["--experimental-strip-types", "--no-warnings"],
        script: FIXTURE,
        port: yield* freePort(),
        logLevel: "Info",
        allowVolatileInstance: false,
      });
      const { pid } = yield* startDetached(directory, launch, Duration.seconds(30)).pipe(
        Effect.provide(services),
      );
      pids.add(pid);

      const refused = yield* upgrade(directory, latest).pipe(Effect.flip, Effect.provide(services));

      assert(refused._tag === "EngineOutsideInstanceError");
      assert.strictEqual(refused.script, FIXTURE);
      assert.isFalse(refused.packaged);
      yield* stop(directory, options).pipe(Effect.provide(services));
    }),
  );

  it.live(
    "reports a version that the registry doesn't have, and a command that exits non-zero",
    () =>
      Effect.gen(function* () {
        const directory = mkdtempSync(join(sqliteTempDirectory(), "usine-upgrade-"));
        folders.push(directory);
        const actual1 = yield* resolveVersion(directory, "@usine/server", "latest").pipe(
          Effect.provide(services),
        );
        assert.strictEqual(actual1, "2.0.0");
        const missing = yield* resolveVersion(directory, "@usine/server", "9.9.9").pipe(
          Effect.flip,
          Effect.provide(services),
        );
        assert.instanceOf(missing, PackageLookupError);
        assert.strictEqual(missing.reason, "no published version matches");
        const failed = yield* runCommand(
          process.execPath,
          ["-e", "process.exit(2)"],
          directory,
          "10 seconds",
        ).pipe(Effect.flip, Effect.provide(services));
        assert.instanceOf(failed, CommandError);
        assert.match(failed.reason, /^exited with status 2/u);
      }),
  );
});

it.live("authenticates system upgrade checks and requests with the local admin-token file", () =>
  Effect.gen(function* () {
    const directory = InstanceDirectory.make(
      mkdtempSync(join(sqliteTempDirectory(), "usine-system-upgrade-")),
    );
    folders.push(directory);
    mkdirSync(join(directory, ".usine"));
    const token = "u".repeat(43);
    writeFileSync(join(directory, ".usine", "admin-token"), token, { mode: 0o600 });
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      if (request.headers.authorization !== `Bearer ${token}`)
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
        );
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.method === "GET"
            ? Response.json({
                running: "1.0.0",
                channel: "latest",
                mode: "propose",
                supported: true,
                available: "2.0.0",
                phase: "idle",
                message: null,
                outcome: null,
              })
            : Response.json({ ok: true }),
        ),
      );
    });
    yield* Effect.gen(function* () {
      const record = InstanceRecord.make({
        pid: ProcessId.make(process.pid),
        version: "1.0.0",
        startedAt: yield* DateTime.now,
        launch: InstanceLaunch.make({
          node: process.execPath,
          nodeOptions: [],
          script: FIXTURE,
          port: Port.make(8080),
          logLevel: "Info",
          allowVolatileInstance: false,
        }),
      });
      yield* requestSystemUpgrade(
        directory,
        record,
        UpgradeCommand.make({ ...latest, check: true }),
      );
      assert.deepEqual(requests, ["GET /api/upgrade"]);
      yield* requestSystemUpgrade(directory, record, latest);
      assert.deepEqual(requests, ["GET /api/upgrade", "GET /api/upgrade", "POST /api/upgrade"]);
      rmSync(join(directory, ".usine", "admin-token"));
      const refused = yield* requestSystemUpgrade(directory, record, latest).pipe(Effect.flip);
      assert.include(refused.message, "admin token");
      assert.lengthOf(requests, 3);
    }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.provide(services));
  }),
);

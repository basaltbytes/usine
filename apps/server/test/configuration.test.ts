import { jsonKey } from "@usine/core/json-key";
import { HttpClient, FetchHttpClient } from "effect/http";

import { Context, Fiber, Effect, Layer, Option, Schema, Deferred, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { webRequest } from "../../../tooling/test/http.mts";
import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { NodeServices, NodeFileSystem } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { InstanceFolder } from "@usine/config/instance-folder";
import { ConfigParser } from "@usine/config/parser";
import { sqliteConfigurationLayer } from "@usine/config/sqlite";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { createServer } from "node:net";
import { ConfigurationEntityView, UpgradeView } from "@usine/orchestrator/operator/http";
import { UsineConfig } from "@usine/config/factory";
import { fauxParent } from "@usine/durable/testing";
import { coordinatorBrainTimeout } from "@usine/orchestrator/current-instance";
import { runConfigCommand } from "../src/configuration/cli.ts";
import { parseConfigCommand } from "../src/configuration/command.ts";
import { configurationLayer } from "../src/configuration/runtime.ts";
import { failureMessage } from "../src/failure-message.ts";
import {
  ConfigurationStore,
  configurationDiff,
  configurationEntities,
  ConfigurationEntity,
} from "@usine/config/configuration";

// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, spawnSync } from "node:child_process";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { parse, stringify } from "yaml";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const directoryFixture = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.makeTempDirectory({
        directory: dirname(join(sqliteTempDirectory(), "usine-config-")),
        prefix: basename(join(sqliteTempDirectory(), "usine-config-")),
      }),
    ),
    (directory) =>
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(directory, { recursive: true, force: true }),
      ).pipe(Effect.orDie),
  );
  yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.makeDirectory(join(directory, "agents")),
  );
  yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.makeDirectory(join(directory, "loops")),
  );
  yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.writeFileString(
      join(directory, "usine.yaml"),
      "version: 1\noperator: operator\nrepos: [{ name: acme/project }]\n",
    ),
  );
  yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.writeFileString(
      join(directory, "agents/developer.md"),
      "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nImplement the issue.\n",
    ),
  );
  yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.writeFileString(
      join(directory, "loops/implement.md"),
      "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement #{{ item.number }}.\n",
    ),
  );
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(join(directory, "pi"));
  yield* fs.writeFileString(
    join(directory, "pi/settings.json"),
    jsonKey({ defaultProvider: "local", defaultModel: "parent-test" }),
  );
  yield* fs.writeFileString(
    join(directory, "pi/models.json"),
    jsonKey({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            {
              id: "parent-test",
              name: "Parent test",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  return directory;
});

const run = (directory: string, args: ReadonlyArray<string>, editor = "") =>
  spawnSync(process.execPath, [cli, "config", ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      EDITOR: editor,
      PI_CODING_AGENT_DIR: join(directory, "pi"),
      PI_OFFLINE: "1",
    },
  });

const storedConfiguration = (directory: string) => {
  const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
  try {
    return {
      revisions: database.prepare("SELECT * FROM usine_configuration_revisions").all(),
      entities: database.prepare("SELECT * FROM usine_configuration_entities").all(),
    };
  } finally {
    database.close();
  }
};

it.live(
  "rejects an invalid parent on the first import",
  () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const fs = yield* FileSystem.FileSystem;
      const agent = join(directory, "agents/developer.md");
      const original = yield* fs.readFileString(agent);
      yield* fs.writeFileString(
        agent,
        original.replace("effort: high", "effort: high\nparent_model: unknown/x"),
      );
      const rejected = run(directory, ["import", directory]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).toContain("cannot run as coordinator");
      const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
      try {
        expect(database.prepare("SELECT * FROM usine_configuration_revisions").all()).toHaveLength(
          0,
        );
      } finally {
        database.close();
      }
      yield* fs.writeFileString(agent, original);
      const accepted = run(directory, ["import", directory]);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain("Revision 1:");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  { timeout: 60_000 },
);

it.live.each(["agent", "settings"] as const)(
  "rejects an imported %s parent before writing a revision",
  (source) =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const fs = yield* FileSystem.FileSystem;
      const exported = join(directory, "exported");
      const initial = run(directory, ["export", exported]);
      expect(initial.status, initial.stderr).toBe(0);
      const before = storedConfiguration(directory);
      const file = join(exported, source === "agent" ? "agents/developer.md" : "usine.yaml");
      const original = yield* fs.readFileString(file);
      yield* fs.writeFileString(
        file,
        source === "agent"
          ? original.replace("effort: high", "effort: high\nparent_model: unknown/x")
          : stringify({
              ...parse(original),
              settings: { ...parse(original).settings, parent_model: "unknown/x" },
            }),
      );
      const rejected = run(directory, ["import", exported]);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).toContain("cannot run as coordinator");
      expect(rejected.stdout + rejected.stderr).toContain("unknown/x");
      expect(storedConfiguration(directory)).toEqual(before);
      yield* fs.writeFileString(file, original);
      expect(run(directory, ["import", exported]).status).toBe(0);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  { timeout: 60_000 },
);

it.live(
  "rejects an edited parent before writing a revision",
  () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      expect(run(directory, ["log"]).status).toBe(0);
      const before = storedConfiguration(directory);
      const editor = join(directory, "parent-editor.mjs");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          editor,
          `import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, readFileSync(file, "utf8").replace("effort: high", "effort: high\\nparent_model: unknown/x"));
`,
        ),
      );
      const rejected = run(
        directory,
        ["edit", "agent", "developer"],
        `${process.execPath} ${editor}`,
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).toContain("cannot run as coordinator");
      expect(storedConfiguration(directory)).toEqual(before);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  { timeout: 60_000 },
);

it.effect("refuses an import whose coordinator brain check doesn't finish in time", () =>
  Effect.gen(function* () {
    const folder = yield* directoryFixture;
    const directory = InstanceDirectory.make(folder);
    const context = yield* Layer.build(
      configurationLayer.pipe(Layer.provide(localSqliteLayer(directory))),
    );
    const checking = yield* Deferred.make<void>();
    const parents = {
      ...fauxParent([]),
      credentials: {
        route: "gateway",
        authentication: () =>
          Deferred.succeed(checking, undefined).pipe(Effect.andThen(Effect.never)),
      },
    } as const;
    const command = yield* parseConfigCommand(["import", directory]);
    const importing = yield* runConfigCommand(directory, command, () =>
      Effect.succeed(parents),
    ).pipe(Effect.provideContext(context), Effect.flip, Effect.forkChild);
    yield* Deferred.await(checking);
    yield* TestClock.adjust(coordinatorBrainTimeout);
    const failure = yield* Fiber.join(importing);

    expect(failure._tag).toBe("ValidationTimeoutError");
    expect(failureMessage(failure)).toBe(
      "The coordinator brain check didn't finish within 10 seconds. The running configuration is unchanged. Check that the model provider responds, then try again. No revision was written.",
    );
    expect((yield* Context.get(context, ConfigurationStore).read).number).toBe(0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "round-trips all entity kinds and records only an added or removed worker",
  () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const source = join(directory, "usine.yaml");
      {
        const awaited1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(source),
        );
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(source, `${awaited1}labels: [{ name: ready }]\n`),
        );
      }
      const exported = join(directory, "exported");
      const result = run(directory, ["export", exported]);
      expect(result.status, result.stderr).toBe(0);
      const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
      try {
        const stored = database
          .prepare("SELECT value FROM usine_configuration_entities")
          .all()
          .map(
            (row) =>
              // The SQLite fixture mapper returns decoded rows synchronously.
              // @effect-diagnostics-next-line schemaSync:off
              Schema.decodeUnknownSync(
                Schema.Struct({
                  value: Schema.fromJsonString(Schema.toCodecJson(ConfigurationEntity)),
                }),
              )(row).value,
          );
        expect(new Set(stored.map(({ key }) => key.kind))).toEqual(
          new Set(["settings", "worker", "repository", "project", "label", "loop", "agent"]),
        );
        expect(stored.find(({ key }) => key.kind === "loop")?.value).toMatchObject({
          maxCycles: 3,
          permissions: "write",
        });
        const revisions = () =>
          database.prepare("SELECT value FROM usine_configuration_revisions ORDER BY number").all();
        const unchanged = run(directory, ["import", exported]);
        expect(unchanged.status, unchanged.stderr).toBe(0);
        expect(unchanged.stdout).toContain("No configuration changes.");
        expect(revisions()).toHaveLength(1);

        const yaml = join(exported, "usine.yaml");
        const original = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(yaml),
        );
        const awaited2 = yield* Schema.decodeUnknownEffect(UsineConfig)(parse(original));
        const config = yield* Schema.encodeEffect(UsineConfig)(awaited2);
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(
            yaml,
            stringify({
              ...config,
              workers: [...(config.workers ?? []), { name: "extra", kind: "local" }],
            }),
          ),
        );
        for (const action of ["Added", "Removed"]) {
          const imported = run(directory, ["import", exported]);
          expect(imported.status, imported.stderr).toBe(0);
          expect(imported.stdout).toContain("1 change(s).");
          expect(imported.stdout).toContain(`${action} worker extra`);
          expect(imported.stdout).not.toContain("Changed");
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.writeFileString(yaml, original),
          );
        }
        expect(revisions()).toHaveLength(3);
        const history = run(directory, ["log", "loop", "implement"]);
        expect(history.status, history.stderr).toBe(0);
        expect(history.stdout).toContain("1\tlocal admin\t");
        expect(history.stdout).not.toMatch(/[23]\tlocal admin\t/);
        expect(run(directory, ["import", exported]).stdout).toContain("No configuration changes.");
        expect(revisions()).toHaveLength(3);
      } finally {
        database.close();
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  { timeout: 60_000 },
);

it.live(
  "imports and exports worker preference changes with and without value edits",
  () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const source = join(directory, "usine.yaml");
      const settings = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(source),
      );
      const writeWorkers = (names: ReadonlyArray<string>, capacity: number) =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(
            source,
            `${settings}workers:\n${names.map((name) => `  - name: ${name}\n    kind: local\n    max_concurrent_attempts: ${capacity}\n`).join("")}`,
          ),
        );
      yield* writeWorkers(["preferred", "fallback"], 1);
      const initial = run(directory, ["log"]);
      expect(initial.status, initial.stderr).toBe(0);
      const exported = join(directory, "exported");
      for (const { names, capacity, revision } of [
        { names: ["fallback", "preferred"], capacity: 1, revision: 2 },
        { names: ["preferred", "fallback"], capacity: 2, revision: 3 },
      ]) {
        yield* writeWorkers(names, capacity);
        const imported = run(directory, ["import", directory]);
        expect(imported.status, imported.stderr).toBe(0);
        expect(imported.stdout).toContain(`Revision ${revision}:`);
        expect(run(directory, ["log", "worker", "preferred"]).stdout).toContain(
          `${revision}\tlocal admin\t`,
        );
        const result = run(directory, ["export", exported]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`Exported revision ${revision}`);
        const awaited3 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(join(exported, "usine.yaml")),
        );
        const config = yield* Schema.decodeUnknownEffect(UsineConfig)(parse(awaited3));
        expect(config.workers.map(({ name }) => name)).toEqual(names);
        expect(config.workers.map(({ maxConcurrentAttempts }) => maxConcurrentAttempts)).toEqual([
          capacity,
          capacity,
        ]);
        const unchanged = run(directory, ["import", exported]);
        expect(unchanged.status, unchanged.stderr).toBe(0);
        expect(unchanged.stdout).toContain("No configuration changes");
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  { timeout: 60_000 },
);

it.live(
  "imports once, exports the configuration and edits an agent, and refuses invalid imports and stale edits",
  () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const first = run(directory, ["log"]);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("1\tlocal admin\t");
      expect(first.stdout).toContain("Imported from the instance folder");
      const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
      const count = () =>
        database.prepare("SELECT count(*) AS count FROM usine_configuration_revisions").get()
          ?.count;
      expect(count()).toBe(1);
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(join(directory, "usine.yaml")),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(join(directory, "agents"), { recursive: true }),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(join(directory, "loops"), { recursive: true }),
      );
      const exported = join(directory, "exported");
      expect(run(directory, ["export", exported]).status).toBe(0);
      const actual1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(exported, "agents/developer.md")),
      );
      expect(actual1).toContain("harness: codex");
      expect(run(directory, ["import", exported]).stdout).toContain("No configuration changes");
      expect(count()).toBe(1);

      const editor = join(directory, "editor.mjs");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          editor,
          `import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, readFileSync(file, "utf8").replace("harness: codex", "harness: claude"));
`,
        ),
      );
      const edited = run(
        directory,
        ["edit", "agent", "developer"],
        `${process.execPath} ${editor}`,
      );
      expect(edited.status, edited.stderr).toBe(0);
      expect(edited.stdout).toContain("Changed agent developer");
      expect(count()).toBe(2);
      expect(run(directory, ["log", "agent", "developer"]).stdout).toContain("2\tlocal admin\t");

      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(join(exported, "agents/developer.md"), "invalid"),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          join(exported, "projects/acme-project/loops/implement.md"),
          "invalid",
        ),
      );
      const invalid = run(directory, ["import", exported]);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("agents/developer.md");
      expect(invalid.stderr).toContain("loops/implement.md");
      expect(count()).toBe(2);
      expect(run(directory, ["export", exported]).status).toBe(0);

      const staleEditor = join(directory, "stale-editor.mjs");
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          staleEditor,
          `import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const yaml = ${jsonKey(join(exported, "usine.yaml"))};
writeFileSync(yaml, readFileSync(yaml, "utf8").replace("poll_interval: 60", "poll_interval: 45"));
execFileSync(process.execPath, [${jsonKey(cli)}, "config", "import", ${jsonKey(exported)}, "--message", "Concurrent import"]);
writeFileSync(process.argv[2], readFileSync(process.argv[2], "utf8").replace("harness: claude", "harness: codex"));
`,
        ),
      );
      const stale = run(
        directory,
        ["edit", "agent", "developer"],
        `${process.execPath} ${staleEditor}`,
      );
      expect(stale.status, stale.stdout).toBe(1);
      expect(stale.stderr).toContain("Configuration changed from revision 2 to 3");
      expect(count()).toBe(3);
      expect(run(directory, ["log", "settings", "instance"]).stdout).toContain("Concurrent import");
      database.close();
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  { timeout: 90_000 },
);

const AgentView = Schema.Struct({
  agents: Schema.Array(Schema.Struct({ harness: Schema.String })),
});

it.live(
  "imports at first server start, follows CLI commits, and ignores later file edits",
  () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          join(directory, "usine.yaml"),
          "version: 1\nrepos: [{ name: acme/project }]\n",
        ),
      );
      const authorization = () =>
        Effect.gen(function* () {
          return {
            authorization: `Bearer ${(yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.readFileString(join(directory, ".usine/admin-token")))).trim()}`,
          };
        });
      const reservation = createServer();
      yield* Effect.callback<void>((resume) => {
        const resolve = (value: void) => resume(Effect.succeed(value));
        reservation.listen(0, "127.0.0.1", resolve);
      });
      const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
        reservation.address(),
      );
      yield* Effect.callback<void>((resume) => {
        const resolve = (value: void) => resume(Effect.succeed(value));
        const reject = (error: Error) => resume(Effect.die(error));
        reservation.close((error) => (error !== undefined ? reject(error) : resolve()));
      });
      const child = spawn(
        process.execPath,
        [cli, "up", "--port", String(port), "--allow-volatile-instance"],
        {
          cwd: directory,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      const exited = (() => {
        const completion = Deferred.makeUnsafe<void>();
        const resolve = (value: void) => {
          Deferred.doneUnsafe(completion, Effect.succeed(value));
        };
        child.once("exit", () => resolve());
        return Deferred.await(completion);
      })();
      const origin = `http://127.0.0.1:${port}`;
      const harness = () =>
        Effect.gen(function* () {
          const headers = yield* authorization();
          const response = yield* webRequest(`${origin}/api/configuration`, { headers });
          const body = yield* Effect.promise(() => response.json());
          const configuration = yield* Schema.decodeUnknownEffect(AgentView)(body);
          return configuration.agents[0]?.harness;
        });
      const pollContext = yield* Effect.context<FileSystem.FileSystem | HttpClient.HttpClient>();
      // Bounds each request so a request that never gets a response can't use up the whole poll.
      const pollHarness = () =>
        Effect.runPromiseWith(pollContext)(harness().pipe(Effect.timeout("2 seconds")));
      try {
        yield* Effect.promise(() =>
          expect.poll(() => pollHarness().catch(() => output), { timeout: 20_000 }).toBe("codex"),
        );
        expect(output).not.toContain("/sign-in#link=");
        expect(output).toContain("Run usine sign-in-link");
        expect(run(directory, ["log"]).stdout).toContain("Imported from the instance folder");
        expect(
          (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.stat(join(directory, ".usine/admin-token")),
          )).mode & 0o777,
        ).toBe(0o600);
        expect((yield* webRequest(`${origin}/api/configuration`)).status).toBe(401);
        const linkCommand = spawnSync(process.execPath, [cli, "sign-in-link"], {
          cwd: directory,
          encoding: "utf8",
        });
        expect(linkCommand.status, linkCommand.stderr).toBe(0);
        const link = linkCommand.stdout.match(
          /http:\/\/127\.0\.0\.1:\d+\/sign-in#link=([A-Za-z0-9_-]+)/u,
        );
        expect(link).not.toBeNull();
        const consume = () =>
          webRequest(`${origin}/api/auth/link/consume`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: jsonKey({ token: link?.[1] }),
          });
        expect((yield* consume()).status).toBe(200);
        expect((yield* consume()).status).toBe(401);

        const upgrades = () =>
          Effect.gen(function* () {
            const awaited3 = yield* authorization();
            const awaited4 = yield* webRequest(`${origin}/api/upgrade`, { headers: awaited3 });
            const body = yield* Effect.promise(() => awaited4.json());
            return yield* Schema.decodeUnknownEffect(UpgradeView)(body);
          });
        const actual2 = yield* upgrades();
        expect(actual2).toMatchObject({
          channel: "latest",
          mode: "propose",
        });
        const settingsEditor = join(directory, "settings-editor.mjs");
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(
            settingsEditor,
            `import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, readFileSync(file, "utf8").replace("upgrade_channel: latest", "upgrade_channel: next").replace("upgrade_mode: propose", "upgrade_mode: automatic"));
`,
          ),
        );
        const settingsEdit = run(
          directory,
          ["edit", "settings", "instance"],
          `${process.execPath} ${settingsEditor}`,
        );
        expect(settingsEdit.status, settingsEdit.stderr).toBe(0);
        yield* Effect.promise(() =>
          expect
            .poll(() => Effect.runPromiseWith(pollContext)(upgrades()), { timeout: 10_000 })
            .toMatchObject({
              channel: "next",
              mode: "automatic",
            }),
        );

        const editor = join(directory, "live-editor.mjs");
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(
            editor,
            `import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, readFileSync(file, "utf8").replace("harness: codex", "harness: claude"));
`,
          ),
        );
        const edit = run(
          directory,
          ["edit", "agent", "developer"],
          `${process.execPath} ${editor}`,
        );
        expect(edit.status, edit.stderr).toBe(0);
        yield* Effect.promise(() => expect.poll(pollHarness, { timeout: 10_000 }).toBe("claude"));
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(join(directory, "usine.yaml"), "invalid"),
        );
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(join(directory, "agents/developer.md"), "invalid"),
        );
        const actual3 = yield* harness();
        expect(actual3).toBe("claude");
        const awaited4 = yield* authorization();
        const awaited5 = yield* webRequest(`${origin}/api/configuration/entities/agent/developer`, {
          headers: awaited4,
        });
        const body = yield* Effect.promise(() => awaited5.json());
        const entity = yield* Schema.decodeUnknownEffect(ConfigurationEntityView)(body);
        const awaited6 = yield* authorization();
        const saved = yield* webRequest(`${origin}/api/configuration/entities/agent/developer`, {
          method: "PUT",
          headers: { Origin: origin, ...awaited6 },
          body: jsonKey({
            expected: entity.number,
            text: entity.text.replace("harness: claude", "harness: codex"),
          }),
        });
        const actual4 = yield* Effect.promise(() => saved.text());
        expect(saved.status, actual4).toBe(200);
        const actual5 = yield* harness();
        expect(actual5).toBe("codex");
      } finally {
        child.kill("SIGTERM");
        const kill = yield* Effect.sleep(5000).pipe(
          Effect.andThen(Effect.sync(() => child.kill("SIGKILL"))),
          Effect.forkScoped,
        );
        yield* exited;
        yield* Fiber.interrupt(kill);
      }
    }).pipe(Effect.provide(Layer.provideMerge(NodeFileSystem.layer, FetchHttpClient.layer))),
  { timeout: 60_000 },
);

it.live(
  "pauses imported loops atomically and preserves the migration's pause state",
  () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      expect(run(directory, ["log"]).status).toBe(0);
      const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
      try {
        expect(database.prepare("SELECT * FROM usine_loop_runtime").all()).toEqual([]);
        const loop = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readFileString(join(directory, "loops/implement.md")),
        );
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(join(directory, "loops/review.md"), loop),
        );
        database.exec(
          "CREATE TRIGGER refuse_loop_pause BEFORE INSERT ON usine_loop_runtime BEGIN SELECT RAISE(ABORT, 'pause unavailable'); END",
        );
        const refused = run(directory, ["import", directory]);
        expect(refused.status).toBe(1);
        expect(
          database.prepare("SELECT count(*) AS count FROM usine_configuration_revisions").get()
            ?.count,
        ).toBe(1);
        expect(
          database
            .prepare(
              "SELECT * FROM usine_configuration_entities WHERE key = 'loop:acme-project/review'",
            )
            .all(),
        ).toEqual([]);
        database.exec("DROP TRIGGER refuse_loop_pause");
        const imported = run(directory, ["import", directory]);
        expect(imported.status, imported.stderr).toBe(0);
        expect(database.prepare("SELECT * FROM usine_loop_runtime").all()).toEqual([
          { loop_name: "acme-project/review", paused: 1 },
        ]);
        database
          .prepare(
            "UPDATE usine_loop_runtime SET paused = 0 WHERE loop_name = 'acme-project/review'",
          )
          .run();
        expect(run(directory, ["import", directory]).status).toBe(0);
        expect(
          database
            .prepare(
              "SELECT paused FROM usine_loop_runtime WHERE loop_name = 'acme-project/review'",
            )
            .get()?.paused,
        ).toBe(0);
      } finally {
        database.close();
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  { timeout: 30_000 },
);

for (const scenario of [
  { repositories: ["basaltbytes/usine"], loops: ["implement", "review", "fix", "finish", "check"] },
  { repositories: ["acme/one", "acme/two"], loops: ["implement"] },
]) {
  it.live(
    `migrates a part-1 store with ${scenario.repositories.length} repositories and ${scenario.loops.length} loops as one revision`,
    () =>
      Effect.gen(function* () {
        const directory = yield* directoryFixture;
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(
            join(directory, "usine.yaml"),
            stringify({
              version: 1,
              operator: "operator",
              repos: scenario.repositories.map((name) => ({
                name,
                lanes: [{ name: "Ready", sources: [{ label: "ready" }] }],
              })),
            }),
          ),
        );
        for (const name of scenario.loops)
          yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.writeFileString(
              join(directory, `loops/${name}.md`),
              "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement #{{ item.number }}.\n",
            ),
          );
        const root = InstanceDirectory.make(directory);
        const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
        const legacyStore = Layer.mergeAll(sqliteConfigurationLayer, InstanceFolder.layer).pipe(
          Layer.provide(parser),
          Layer.provide(localSqliteLayer(root)),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const instance = yield* (yield* InstanceFolder).load(root);
          const store = yield* ConfigurationStore;
          const current = yield* store.read;
          const decodedValue2 = configurationEntities(instance);
          yield* store.commit({
            expected: current.number,
            actor: instance.config.operator,
            message: Option.some("Part 1 configuration"),
            changes: configurationDiff([], decodedValue2),
          });
        }).pipe(Effect.provide(legacyStore), Effect.scoped);
        const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
        try {
          database
            .prepare("INSERT INTO usine_loop_runtime (loop_name, paused) VALUES ('implement', 1)")
            .run();
          const exported = join(directory, "exported");
          const result = run(directory, ["export", exported]);
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("Exported revision 2");
          const revisions = database
            .prepare("SELECT value FROM usine_configuration_revisions ORDER BY number")
            .all();
          expect(revisions).toHaveLength(2);
          expect(revisions[1]?.value).toContain("Migrated repositories and loops to projects");
          const awaited7 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
            fileSystem.readFileString(join(exported, "usine.yaml")),
          );
          const config = yield* Schema.decodeUnknownEffect(UsineConfig)(parse(awaited7));
          expect(config.version).toBe(2);
          expect(config.projects).toHaveLength(scenario.repositories.length);
          for (const project of config.projects) {
            expect(project.lanes[0]?.name).toBe("Ready");
            expect(
              database
                .prepare("SELECT paused FROM usine_loop_runtime WHERE loop_name = ?")
                .get(`${project.id}/implement`)?.paused,
            ).toBe(1);
            for (const name of scenario.loops) {
              const loop = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
                fileSystem.readFileString(
                  join(exported, `projects/${project.id}/loops/${name}.md`),
                ),
              );
              expect(loop).toContain("Implement #{{ item.number }}.");
            }
          }
          const reimported = run(directory, ["import", exported]);
          expect(reimported.status, reimported.stderr).toBe(0);
          expect(reimported.stdout).toContain("No configuration changes.");
          expect(
            database.prepare("SELECT count(*) AS count FROM usine_configuration_revisions").get()
              ?.count,
          ).toBe(2);
        } finally {
          database.close();
        }
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    { timeout: 60_000 },
  );
}

for (const scenario of ["empty registry", "unmatched selector"] as const) {
  it.live(`preserves authored loops and revisions when migration has an ${scenario}`, () =>
    Effect.gen(function* () {
      const directory = yield* directoryFixture;
      const repos =
        scenario === "empty registry"
          ? []
          : [
              { name: "acme/one", tags: ["app"] },
              { name: "acme/two", tags: ["other"] },
            ];
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(join(directory, "usine.yaml"), stringify({ version: 1, repos })),
      );
      const selector =
        scenario === "empty registry" ? "" : "selector: { repos: [acme/one], tags: [other] }\n";
      for (const name of ["implement", "review"])
        yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.writeFileString(
            join(directory, `loops/${name}.md`),
            `---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n${selector}---\nImplement.\n`,
          ),
        );
      const root = InstanceDirectory.make(directory);
      const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
      const legacyStore = Layer.mergeAll(sqliteConfigurationLayer, InstanceFolder.layer).pipe(
        Layer.provide(parser),
        Layer.provide(localSqliteLayer(root)),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const instance = yield* (yield* InstanceFolder).load(root);
        const store = yield* ConfigurationStore;
        const current = yield* store.read;
        const decodedValue4 = configurationEntities(instance);
        yield* store.commit({
          expected: current.number,
          actor: instance.config.operator,
          message: Option.some("Part 1 configuration"),
          changes: configurationDiff([], decodedValue4),
        });
      }).pipe(Effect.provide(legacyStore), Effect.scoped);
      const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
      try {
        const entities = () =>
          database.prepare("SELECT * FROM usine_configuration_entities ORDER BY key").all();
        const before = entities();
        const result = run(directory, ["export", join(directory, "exported")]);
        expect(result.status).not.toBe(0);
        for (const name of ["implement", "review"])
          expect(result.stdout + result.stderr).toContain(`Cannot migrate loop ${name}: selector`);
        expect(entities()).toEqual(before);
        expect(
          database.prepare("SELECT count(*) AS count FROM usine_configuration_revisions").get()
            ?.count,
        ).toBe(1);
      } finally {
        database.close();
      }
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
}

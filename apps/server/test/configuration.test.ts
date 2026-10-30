import { sqliteTempDirectory } from "../../../tooling/test/sqlite.mts";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { InstanceFolder } from "@usine/config/instance-folder";
import { ConfigParser } from "@usine/config/parser";
import { sqliteConfigurationLayer } from "@usine/config/sqlite";
import { localSqliteLayer } from "@usine/engine/local-sqlite";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { createServer } from "node:net";
import { ConfigurationEntityView, UpgradeView } from "@usine/orchestrator/operator/http";
import { UsineConfig } from "@usine/config/factory";
import {
  ConfigurationStore,
  configurationDiff,
  configurationEntities,
  ConfigurationEntity,
} from "@usine/config/configuration";
import { Effect, Layer, Option, Schema } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, stringify } from "yaml";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const test = it.extend<{ directory: string }>({
  directory: async ({ task }, use) => {
    const directory = await mkdtemp(join(sqliteTempDirectory(), `usine-config-${task.id}-`));
    await mkdir(join(directory, "agents"));
    await mkdir(join(directory, "loops"));
    await writeFile(
      join(directory, "usine.yaml"),
      "version: 1\noperator: operator\nrepos: [{ name: acme/project }]\n",
    );
    await writeFile(
      join(directory, "agents/developer.md"),
      "---\nharness: codex\nmodel: gpt-6.1-sol\neffort: high\n---\nImplement the issue.\n",
    );
    await writeFile(
      join(directory, "loops/implement.md"),
      "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement #{{ item.number }}.\n",
    );
    try {
      await use(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

const run = (directory: string, args: ReadonlyArray<string>, editor = "") =>
  spawnSync(process.execPath, [cli, "config", ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, EDITOR: editor },
  });

test(
  "round-trips all entity kinds and records only an added or removed worker",
  { timeout: 60_000 },
  async ({ directory }) => {
    const source = join(directory, "usine.yaml");
    await writeFile(source, `${await readFile(source, "utf8")}labels: [{ name: ready }]\n`);
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
      const original = await readFile(yaml, "utf8");
      const config = Schema.encodeSync(UsineConfig)(
        Schema.decodeUnknownSync(UsineConfig)(parse(original)),
      );
      await writeFile(
        yaml,
        stringify({
          ...config,
          workers: [...(config.workers ?? []), { name: "extra", kind: "local" }],
        }),
      );
      for (const action of ["Added", "Removed"]) {
        const imported = run(directory, ["import", exported]);
        expect(imported.status, imported.stderr).toBe(0);
        expect(imported.stdout).toContain("1 change(s).");
        expect(imported.stdout).toContain(`${action} worker extra`);
        expect(imported.stdout).not.toContain("Changed");
        await writeFile(yaml, original);
      }
      expect(revisions()).toHaveLength(3);
      const history = run(directory, ["log", "loop", "implement"]);
      expect(history.status, history.stderr).toBe(0);
      expect(history.stdout).toContain("1\toperator\t");
      expect(history.stdout).not.toMatch(/[23]\toperator\t/);
      expect(run(directory, ["import", exported]).stdout).toContain("No configuration changes.");
      expect(revisions()).toHaveLength(3);
    } finally {
      database.close();
    }
  },
);

test(
  "imports and exports worker preference changes with and without value edits",
  { timeout: 60_000 },
  async ({ directory }) => {
    const source = join(directory, "usine.yaml");
    const settings = await readFile(source, "utf8");
    const writeWorkers = (names: ReadonlyArray<string>, capacity: number) =>
      writeFile(
        source,
        `${settings}workers:\n${names.map((name) => `  - name: ${name}\n    kind: local\n    max_concurrent_attempts: ${capacity}\n`).join("")}`,
      );
    await writeWorkers(["preferred", "fallback"], 1);
    const initial = run(directory, ["log"]);
    expect(initial.status, initial.stderr).toBe(0);
    const exported = join(directory, "exported");
    for (const { names, capacity, revision } of [
      { names: ["fallback", "preferred"], capacity: 1, revision: 2 },
      { names: ["preferred", "fallback"], capacity: 2, revision: 3 },
    ]) {
      await writeWorkers(names, capacity);
      const imported = run(directory, ["import", directory]);
      expect(imported.status, imported.stderr).toBe(0);
      expect(imported.stdout).toContain(`Revision ${revision}:`);
      expect(run(directory, ["log", "worker", "preferred"]).stdout).toContain(
        `${revision}\toperator\t`,
      );
      const result = run(directory, ["export", exported]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Exported revision ${revision}`);
      const config = Schema.decodeUnknownSync(UsineConfig)(
        parse(await readFile(join(exported, "usine.yaml"), "utf8")),
      );
      expect(config.workers.map(({ name }) => name)).toEqual(names);
      expect(config.workers.map(({ maxConcurrentAttempts }) => maxConcurrentAttempts)).toEqual([
        capacity,
        capacity,
      ]);
      const unchanged = run(directory, ["import", exported]);
      expect(unchanged.status, unchanged.stderr).toBe(0);
      expect(unchanged.stdout).toContain("No configuration changes");
    }
  },
);

test(
  "imports once, exports the configuration and edits an agent, and refuses invalid imports and stale edits",
  { timeout: 90_000 },
  async ({ directory }) => {
    const first = run(directory, ["log"]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("1\toperator\t");
    expect(first.stdout).toContain("Imported from the instance folder");
    const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
    const count = () =>
      database.prepare("SELECT count(*) AS count FROM usine_configuration_revisions").get()?.count;
    expect(count()).toBe(1);
    await rm(join(directory, "usine.yaml"));
    await rm(join(directory, "agents"), { recursive: true });
    await rm(join(directory, "loops"), { recursive: true });
    const exported = join(directory, "exported");
    expect(run(directory, ["export", exported]).status).toBe(0);
    expect(await readFile(join(exported, "agents/developer.md"), "utf8")).toContain(
      "harness: codex",
    );
    expect(run(directory, ["import", exported]).stdout).toContain("No configuration changes");
    expect(count()).toBe(1);

    const editor = join(directory, "editor.mjs");
    await writeFile(
      editor,
      `import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, readFileSync(file, "utf8").replace("harness: codex", "harness: claude"));
`,
    );
    const edited = run(directory, ["edit", "agent", "developer"], `${process.execPath} ${editor}`);
    expect(edited.status, edited.stderr).toBe(0);
    expect(edited.stdout).toContain("Changed agent developer");
    expect(count()).toBe(2);
    expect(run(directory, ["log", "agent", "developer"]).stdout).toContain("2\toperator\t");

    await writeFile(join(exported, "agents/developer.md"), "invalid");
    await writeFile(join(exported, "projects/acme-project/loops/implement.md"), "invalid");
    const invalid = run(directory, ["import", exported]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("agents/developer.md");
    expect(invalid.stderr).toContain("loops/implement.md");
    expect(count()).toBe(2);
    expect(run(directory, ["export", exported]).status).toBe(0);

    const staleEditor = join(directory, "stale-editor.mjs");
    await writeFile(
      staleEditor,
      `import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const yaml = ${JSON.stringify(join(exported, "usine.yaml"))};
writeFileSync(yaml, readFileSync(yaml, "utf8").replace("poll_interval: 60", "poll_interval: 45"));
execFileSync(process.execPath, [${JSON.stringify(cli)}, "config", "import", ${JSON.stringify(exported)}, "--message", "Concurrent import"]);
writeFileSync(process.argv[2], readFileSync(process.argv[2], "utf8").replace("harness: claude", "harness: codex"));
`,
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
  },
);

const AgentView = Schema.Struct({
  agents: Schema.Array(Schema.Struct({ harness: Schema.String })),
});

test(
  "imports at first server start, follows CLI commits, and ignores later file edits",
  { timeout: 60_000 },
  async ({ directory }) => {
    await writeFile(join(directory, "usine.yaml"), "version: 1\nrepos: [{ name: acme/project }]\n");
    const authorization = async () => ({
      authorization: `Bearer ${(await readFile(join(directory, ".usine/admin-token"), "utf8")).trim()}`,
    });
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
      reservation.address(),
    );
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
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
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const harness = async () =>
      Schema.decodeUnknownSync(AgentView)(
        await (
          await fetch(`${origin}/api/configuration`, { headers: await authorization() })
        ).json(),
      ).agents[0]?.harness;
    try {
      await expect
        .poll(
          async () => {
            try {
              return await harness();
            } catch {
              return output;
            }
          },
          { timeout: 20_000 },
        )
        .toBe("codex");
      expect(run(directory, ["log"]).stdout).toContain("Imported from the instance folder");
      expect((await stat(join(directory, ".usine/admin-token"))).mode & 0o777).toBe(0o600);
      expect((await fetch(`${origin}/api/configuration`)).status).toBe(401);
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
        fetch(`${origin}/api/auth/link/consume`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: link?.[1] }),
        });
      expect((await consume()).status).toBe(200);
      expect((await consume()).status).toBe(401);

      const upgrades = async () =>
        Schema.decodeUnknownSync(UpgradeView)(
          await (await fetch(`${origin}/api/upgrade`, { headers: await authorization() })).json(),
        );
      expect(await upgrades()).toMatchObject({ channel: "latest", mode: "propose" });
      const settingsEditor = join(directory, "settings-editor.mjs");
      await writeFile(
        settingsEditor,
        `import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, readFileSync(file, "utf8").replace("upgrade_channel: latest", "upgrade_channel: next").replace("upgrade_mode: propose", "upgrade_mode: automatic"));
`,
      );
      const settingsEdit = run(
        directory,
        ["edit", "settings", "instance"],
        `${process.execPath} ${settingsEditor}`,
      );
      expect(settingsEdit.status, settingsEdit.stderr).toBe(0);
      await expect.poll(upgrades, { timeout: 10_000 }).toMatchObject({
        channel: "next",
        mode: "automatic",
      });

      const editor = join(directory, "live-editor.mjs");
      await writeFile(
        editor,
        `import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
writeFileSync(file, readFileSync(file, "utf8").replace("harness: codex", "harness: claude"));
`,
      );
      const edit = run(directory, ["edit", "agent", "developer"], `${process.execPath} ${editor}`);
      expect(edit.status, edit.stderr).toBe(0);
      await expect.poll(harness, { timeout: 10_000 }).toBe("claude");
      await writeFile(join(directory, "usine.yaml"), "invalid");
      await writeFile(join(directory, "agents/developer.md"), "invalid");
      expect(await harness()).toBe("claude");
      const entity = Schema.decodeUnknownSync(ConfigurationEntityView)(
        await (
          await fetch(`${origin}/api/configuration/entities/agent/developer`, {
            headers: await authorization(),
          })
        ).json(),
      );
      const saved = await fetch(`${origin}/api/configuration/entities/agent/developer`, {
        method: "PUT",
        headers: { Origin: origin, ...(await authorization()) },
        body: JSON.stringify({
          expected: entity.number,
          text: entity.text.replace("harness: claude", "harness: codex"),
        }),
      });
      expect(saved.status, await saved.text()).toBe(200);
      expect(await harness()).toBe("codex");
    } finally {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(kill);
    }
  },
);

test(
  "pauses imported loops atomically and preserves the migration's pause state",
  { timeout: 30_000 },
  async ({ directory }) => {
    expect(run(directory, ["log"]).status).toBe(0);
    const database = new DatabaseSync(join(directory, ".usine/runtime.sqlite"));
    try {
      expect(database.prepare("SELECT * FROM usine_loop_runtime").all()).toEqual([]);
      const loop = await readFile(join(directory, "loops/implement.md"), "utf8");
      await writeFile(join(directory, "loops/review.md"), loop);
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
        .prepare("UPDATE usine_loop_runtime SET paused = 0 WHERE loop_name = 'acme-project/review'")
        .run();
      expect(run(directory, ["import", directory]).status).toBe(0);
      expect(
        database
          .prepare("SELECT paused FROM usine_loop_runtime WHERE loop_name = 'acme-project/review'")
          .get()?.paused,
      ).toBe(0);
    } finally {
      database.close();
    }
  },
);

for (const scenario of [
  { repositories: ["basaltbytes/usine"], loops: ["implement", "review", "fix", "finish", "check"] },
  { repositories: ["acme/one", "acme/two"], loops: ["implement"] },
]) {
  test(
    `migrates a part-1 store with ${scenario.repositories.length} repositories and ${scenario.loops.length} loops as one revision`,
    { timeout: 60_000 },
    async ({ directory }) => {
      await writeFile(
        join(directory, "usine.yaml"),
        stringify({
          version: 1,
          operator: "operator",
          repos: scenario.repositories.map((name) => ({
            name,
            lanes: [{ name: "Ready", sources: [{ label: "ready" }] }],
          })),
        }),
      );
      for (const name of scenario.loops)
        await writeFile(
          join(directory, `loops/${name}.md`),
          "---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n---\nImplement #{{ item.number }}.\n",
        );
      const root = InstanceDirectory.make(directory);
      const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
      const legacyStore = Layer.mergeAll(sqliteConfigurationLayer, InstanceFolder.layer).pipe(
        Layer.provide(parser),
        Layer.provide(localSqliteLayer(root)),
        Layer.provide(NodeServices.layer),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const instance = yield* (yield* InstanceFolder).load(root);
          const store = yield* ConfigurationStore;
          const current = yield* store.read;
          yield* store.commit({
            expected: current.number,
            actor: instance.config.operator,
            message: Option.some("Part 1 configuration"),
            changes: configurationDiff([], configurationEntities(instance)),
          });
        }).pipe(Effect.provide(legacyStore), Effect.scoped),
      );
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
        const config = Schema.decodeUnknownSync(UsineConfig)(
          parse(await readFile(join(exported, "usine.yaml"), "utf8")),
        );
        expect(config.version).toBe(2);
        expect(config.projects).toHaveLength(scenario.repositories.length);
        for (const project of config.projects) {
          expect(project.lanes[0]?.name).toBe("Ready");
          expect(
            database
              .prepare("SELECT paused FROM usine_loop_runtime WHERE loop_name = ?")
              .get(`${project.id}/implement`)?.paused,
          ).toBe(1);
          for (const name of scenario.loops)
            expect(
              await readFile(join(exported, `projects/${project.id}/loops/${name}.md`), "utf8"),
            ).toContain("Implement #{{ item.number }}.");
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
    },
  );
}

for (const scenario of ["empty registry", "unmatched selector"] as const) {
  test(`preserves authored loops and revisions when migration has an ${scenario}`, async ({
    directory,
  }) => {
    const repos =
      scenario === "empty registry"
        ? []
        : [
            { name: "acme/one", tags: ["app"] },
            { name: "acme/two", tags: ["other"] },
          ];
    await writeFile(join(directory, "usine.yaml"), stringify({ version: 1, repos }));
    const selector =
      scenario === "empty registry" ? "" : "selector: { repos: [acme/one], tags: [other] }\n";
    for (const name of ["implement", "review"])
      await writeFile(
        join(directory, `loops/${name}.md`),
        `---\ntrigger: { on: issue, if: 'true' }\nagent: developer\n${selector}---\nImplement.\n`,
      );
    const root = InstanceDirectory.make(directory);
    const parser = ConfigParser.layer.pipe(Layer.provide(MarcbachmannCelLayer));
    const legacyStore = Layer.mergeAll(sqliteConfigurationLayer, InstanceFolder.layer).pipe(
      Layer.provide(parser),
      Layer.provide(localSqliteLayer(root)),
      Layer.provide(NodeServices.layer),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const instance = yield* (yield* InstanceFolder).load(root);
        const store = yield* ConfigurationStore;
        const current = yield* store.read;
        yield* store.commit({
          expected: current.number,
          actor: instance.config.operator,
          message: Option.some("Part 1 configuration"),
          changes: configurationDiff([], configurationEntities(instance)),
        });
      }).pipe(Effect.provide(legacyStore), Effect.scoped),
    );
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
  });
}

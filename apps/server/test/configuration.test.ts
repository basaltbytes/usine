import { createServer } from "node:net";
import { UpgradeView } from "@usine/orchestrator/operator/http";
import { UsineConfig } from "@usine/config/factory";
import { Schema } from "effect";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const test = it.extend<{ directory: string }>({
  directory: async ({ task }, use) => {
    const directory = await mkdtemp(join(tmpdir(), `usine-config-${task.id}-`));
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
    await writeFile(join(exported, "loops/implement.md"), "invalid");
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
  "imports at first server start, follows CLI commits, and reloads the store instead of files",
  { timeout: 60_000 },
  async ({ directory }) => {
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
      Schema.decodeUnknownSync(AgentView)(await (await fetch(`${origin}/api/configuration`)).json())
        .agents[0]?.harness;
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
      const upgrades = async () =>
        Schema.decodeUnknownSync(UpgradeView)(await (await fetch(`${origin}/api/upgrade`)).json());
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
      const reloaded = await fetch(`${origin}/api/instance/reload`, {
        method: "POST",
        headers: { Origin: origin },
      });
      expect(reloaded.status, await reloaded.text()).toBe(200);
      expect(await harness()).toBe("claude");
    } finally {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(kill);
    }
  },
);

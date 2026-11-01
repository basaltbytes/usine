import { rejects } from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createRegistry } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Schema } from "effect";
import { assert, it, onTestFinished } from "vitest";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const server = fileURLToPath(import.meta.resolve("@usine/server/package.json"));
const serverDirectory = dirname(server);
const release = JSON.parse(await readFile(server, "utf8"));

const fixture = async (installer = "npm") => {
  const root = await mkdtemp(join(tmpdir(), "create-usine-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, installer),
    `#!${process.execPath}
import { mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
if (process.argv.slice(2).join(' ') !== ${JSON.stringify(installer === "pnpm" ? "install --ignore-workspace" : "install")}) process.exit(65);
if (process.env.INSTALL_FAILURE) process.exit(42);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('node_modules/@usine', { recursive: true });
mkdirSync('node_modules/.bin', { recursive: true });
symlinkSync(${JSON.stringify(serverDirectory)}, 'node_modules/@usine/server');
symlinkSync(${JSON.stringify(join(serverDirectory, "dist/main.js"))}, 'node_modules/.bin/usine');
if (!process.env.NO_LOCKFILE) writeFileSync(${JSON.stringify(installer === "npm" ? "package-lock.json" : "pnpm-lock.yaml")}, JSON.stringify(manifest));
`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    npm_config_user_agent: `${installer}/11.0.0`,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("USINE_")) delete env[key];
  }
  const folder = join(root, "instance with spaces");
  return {
    root,
    folder,
    env,
    create: (...args: string[]) =>
      exec(process.execPath, [cli, ...args], { env, cwd: root, timeout: 30_000 }),
    usine: (...args: string[]) =>
      exec(process.execPath, [join(folder, "node_modules/.bin/usine"), ...args], {
        env,
        cwd: folder,
        timeout: 30_000,
      }),
  };
};

it.each(["npm", "pnpm"])(
  "scaffolds with %s, pins the release, and installs in the requested folder",
  async (installer) => {
    const f = await fixture(installer);
    onTestFinished(() => rm(f.root, { recursive: true, force: true }));
    const { stdout } = await f.create(f.folder);
    assert.include(stdout, installer === "npm" ? "npm run usine -- up" : "pnpm usine up");
    assert.deepEqual(
      (await readdir(f.folder)).sort(),
      [
        ".env",
        ".gitignore",
        "node_modules",
        "package.json",
        installer === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
      ].sort(),
    );
    const manifest = JSON.parse(await readFile(join(f.folder, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies, { "@usine/server": release.version });
    assert.equal(manifest.private, true);
    assert.deepEqual(manifest.scripts, { usine: "usine" });
    assert.equal(
      await readFile(join(f.folder, ".gitignore"), "utf8"),
      ".usine/\nnode_modules/\n.env\n",
    );
    const env = await readFile(join(f.folder, ".env"), "utf8");
    assert.isTrue(env.split("\n").every((line) => line === "" || line.startsWith("#")));
    assert.include(env, "# USINE_GITHUB_CLIENT_SECRET=");
    assert.equal((await stat(join(f.folder, ".env"))).mode & 0o777, 0o600);
  },
);

it("accepts an existing empty folder and refuses to overwrite its contents on a second run", async () => {
  const f = await fixture();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(f.folder);
  await f.create(f.folder);
  await writeFile(join(f.folder, ".env"), "TOKEN=keep-me\n");
  await rejects(f.create(f.folder), /Choose a new or empty folder/);
  assert.equal(await readFile(join(f.folder, ".env"), "utf8"), "TOKEN=keep-me\n");
});

it("isolates a real pnpm install from an enclosing workspace", async () => {
  const f = await fixture("pnpm");
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  const manifest = { name: "@usine/server", version: release.version };
  await mkdir(join(f.root, "package"));
  await writeFile(join(f.root, "package/package.json"), JSON.stringify(manifest));
  await exec("tar", ["-czf", "server.tgz", "package"], { cwd: f.root });
  const tarball = await readFile(join(f.root, "server.tgz"));
  const registry = createRegistry((request, response) => {
    if (request.url === "/server.tgz") {
      response.end(tarball);
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          name: manifest.name,
          "dist-tags": { latest: release.version },
          versions: {
            [release.version]: {
              ...manifest,
              dist: { tarball: `http://${request.headers.host}/server.tgz` },
            },
          },
        }),
      );
    }
  });
  onTestFinished(() => new Promise<void>((resolve) => registry.close(() => resolve())));
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    registry.address(),
  );
  await writeFile(join(f.root, "package.json"), JSON.stringify({ private: true }));
  await writeFile(join(f.root, "pnpm-workspace.yaml"), "packages:\n  - instances/*\n");
  const folder = join(f.root, "instances/factory");
  const { stdout } = await exec(process.execPath, [cli, folder], {
    cwd: f.root,
    env: {
      ...f.env,
      PATH: process.env.PATH,
      pnpm_config_registry: `http://127.0.0.1:${port}`,
    },
    timeout: 30_000,
  });
  assert.include(stdout, "pnpm usine up");
  assert.include(await readFile(join(folder, "pnpm-lock.yaml"), "utf8"), "@usine/server");
  assert.deepEqual(
    JSON.parse(await readFile(join(folder, "node_modules/@usine/server/package.json"), "utf8")),
    manifest,
  );
  assert.notInclude(await readdir(f.root), "pnpm-lock.yaml");
  assert.notInclude(await readdir(f.root), "node_modules");
}, 60_000);

it.each([
  ["npm", "INSTALL_FAILURE", "Installation exited with status 42"],
  ["npm", "NO_LOCKFILE", "Installation did not write package-lock.json"],
  ["pnpm", "INSTALL_FAILURE", "Installation exited with status 42"],
  ["pnpm", "NO_LOCKFILE", "Installation did not write pnpm-lock.yaml"],
])("reports %s %s without claiming setup succeeded", async (installer, variable, message) => {
  const f = await fixture(installer);
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await rejects(
    exec(process.execPath, [cli, f.folder], {
      env: { ...f.env, [variable]: "1" },
      timeout: 30_000,
    }),
    new RegExp(
      `${message}.*${installer} install${installer === "pnpm" ? " --ignore-workspace" : ""} in this folder`,
    ),
  );
  assert.equal(
    JSON.parse(await readFile(join(f.folder, "package.json"), "utf8")).dependencies[
      "@usine/server"
    ],
    release.version,
  );
});

it("shows help and rejects missing arguments and unsupported installers before writing files", async () => {
  const f = await fixture("yarn");
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  assert.include((await f.create("--help")).stdout, "create-usine");
  await rejects(f.create());
  await rejects(f.create(f.folder), /Use npm create usine/);
  assert.deepEqual(await readdir(f.root), ["bin"]);
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
        listener.address(),
      );
      listener.close(() => resolve(address.port));
    });
  });

it("starts the scaffolded folder detached in setup mode with one empty revision and resumes it", async () => {
  const f = await fixture();
  onTestFinished(async () => {
    try {
      await f.usine("stop", "--force", "--timeout", "10");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  await f.create(f.folder);
  const port = await freePort();
  const args = ["up", "--detach", "--port", String(port), "--allow-volatile-instance"];
  await f.usine(...args);
  const token = (await readFile(join(f.folder, ".usine/admin-token"), "utf8")).trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/setup`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { _tag: "NoApp" });
  assert.include(
    await readFile(join(f.folder, ".usine/usine.log"), "utf8"),
    "running in setup mode",
  );
  await f.usine("stop");
  await f.usine(...args);
  await f.usine("stop");
  const database = new DatabaseSync(join(f.folder, ".usine/runtime.sqlite"), { readOnly: true });
  try {
    const revisions = database
      .prepare("SELECT number, value FROM usine_configuration_revisions")
      .all();
    assert.lengthOf(revisions, 1);
    assert.equal(revisions[0]?.number, 1);
    assert.include(String(revisions[0]?.value), "Initialized empty configuration");
    const entities = database.prepare("SELECT key FROM usine_configuration_entities").all();
    assert.isFalse(
      entities.some(({ key }) => /^(repository|project|agent|loop):/.test(String(key))),
    );
  } finally {
    database.close();
  }
}, 60_000);

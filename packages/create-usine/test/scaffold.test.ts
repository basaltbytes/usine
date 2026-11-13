import { jsonKey } from "@usine/core/json-key";
import { FetchHttpClient } from "effect/http";
import { webRequest } from "../../../tooling/test/http.mts";
import { NodeFileSystem } from "@effect/platform-node";
// Test registration reads the installed release before fixtures run.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";

import { rejects } from "node:assert/strict";
// The Node process boundary uses native process handles and synchronous subprocess operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { once } from "node:events";
// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer as createRegistry } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
// Synchronous Node path callbacks retain the host platform’s path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect, Schema, Deferred, Config, Option, FileSystem, Layer, Schedule } from "effect";
import { assert, it } from "@effect/vitest";

// Scaffold assertions synchronously read package manifest fields.
// @effect-diagnostics-next-line schemaSync:off
const parseJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
// The manifest decoder is cached for synchronous fixture assertions.
// @effect-diagnostics-next-line schemaSync:off
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ dependencies: Schema.Record(Schema.String, Schema.String) }),
  ),
);

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const server = fileURLToPath(import.meta.resolve("@usine/server/package.json"));
const serverDirectory = dirname(server);
// Package metadata is read once during synchronous test registration.
// @effect-diagnostics-next-line schemaSync:off
const decodeRelease = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
);
const release = decodeRelease(readFileSync(server, "utf8"));

const fixture = (installer = "npm") =>
  Effect.gen(function* () {
    const actual12 = yield* Config.option(Config.String("PATH"));
    const environmentPATH1 = Option.getOrUndefined(actual12);
    const root = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.makeTempDirectory({
        directory: dirname(join(tmpdir(), "create-usine-")),
        prefix: basename(join(tmpdir(), "create-usine-")),
      }),
    );
    const bin = join(root, "bin");
    yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.makeDirectory(bin));
    yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.writeFileString(
        join(bin, installer),
        `#!${process.execPath}
import { mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
if (process.argv.slice(2).join(' ') !== ${jsonKey(installer === "pnpm" ? "install --ignore-workspace" : "install --workspaces=false")}) process.exit(65);
if (process.env.INSTALL_FAILURE) process.exit(42);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('node_modules/@usine', { recursive: true });
mkdirSync('node_modules/.bin', { recursive: true });
symlinkSync(${jsonKey(serverDirectory)}, 'node_modules/@usine/server');
symlinkSync(${jsonKey(join(serverDirectory, "dist/main.js"))}, 'node_modules/.bin/usine');
if (!process.env.NO_LOCKFILE) writeFileSync(${jsonKey(installer === "npm" ? "package-lock.json" : "pnpm-lock.yaml")}, JSON.stringify(manifest));
`,
        { mode: 0o755 },
      ),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${environmentPATH1}`,
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
  });

it.live.each(["npm", "pnpm"])(
  "scaffolds with %s, pins the release, and installs in the requested folder",
  (installer) =>
    Effect.gen(function* () {
      const f = yield* fixture(installer);
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(f.root, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
      );
      const { stdout } = yield* Effect.promise(() => f.create(f.folder));
      assert.include(stdout, installer === "npm" ? "npm run usine -- up" : "pnpm usine up");
      assert.deepEqual(
        (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.readDirectory(f.folder),
        )).sort(),
        [
          ".env",
          ".gitignore",
          "node_modules",
          "package.json",
          installer === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
        ].sort(),
      );
      const actual1 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(f.folder, "package.json")),
      );
      const manifest = parseJson(actual1);
      assert.deepEqual(manifest.dependencies, { "@usine/server": release.version });
      assert.equal(manifest.private, true);
      assert.deepEqual(manifest.scripts, { usine: "usine" });
      const actual2 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(f.folder, ".gitignore")),
      );
      assert.equal(actual2, ".usine/\nnode_modules/\n.env\n");
      const env = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(f.folder, ".env")),
      );
      assert.isTrue(env.split("\n").every((line) => line === "" || line.startsWith("#")));
      assert.include(env, "# USINE_GITHUB_CLIENT_SECRET=");
      assert.equal(
        (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.stat(join(f.folder, ".env")),
        )).mode & 0o777,
        0o600,
      );
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live(
  "accepts an existing empty folder and refuses to overwrite its contents on a second run",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(f.root, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeDirectory(f.folder),
      );
      yield* Effect.promise(() => f.create(f.folder));
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(join(f.folder, ".env"), "TOKEN=keep-me\n"),
      );
      yield* Effect.promise(() => rejects(f.create(f.folder), /Choose a new or empty folder/));
      const actual3 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(f.folder, ".env")),
      );
      assert.equal(actual3, "TOKEN=keep-me\n");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live.each(["npm", "pnpm"])(
  "isolates a real %s install from an enclosing workspace",
  (installer) =>
    Effect.gen(function* () {
      const actual13 = yield* Config.option(Config.String("PATH"));
      const environmentPATH2 = Option.getOrUndefined(actual13);
      const f = yield* fixture(installer);
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(f.root, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
      );
      const manifest = { name: "@usine/server", version: release.version };
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.makeDirectory(join(f.root, "package")),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(join(f.root, "package/package.json"), jsonKey(manifest)),
      );
      yield* Effect.promise(() => exec("tar", ["-czf", "server.tgz", "package"], { cwd: f.root }));
      const tarball = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFile(join(f.root, "server.tgz")).pipe(Effect.map(Buffer.from)),
      );
      const registry = createRegistry((request, response) => {
        if (request.url === "/server.tgz") {
          response.end(tarball);
        } else {
          response.setHeader("Content-Type", "application/json");
          response.end(
            jsonKey({
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
      yield* Effect.addFinalizer(() =>
        (() => {
          const completion = Deferred.makeUnsafe<void>();
          const resolve = (value: void) => {
            Deferred.doneUnsafe(completion, Effect.succeed(value));
          };
          registry.close(() => resolve());
          return Deferred.await(completion);
        })(),
      );
      registry.listen(0, "127.0.0.1");
      yield* Effect.promise(() => once(registry, "listening"));
      const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Finite }))(
        registry.address(),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          join(f.root, "package.json"),
          jsonKey({
            private: true,
            workspaces: ["instances/*"],
          }),
        ),
      );
      yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.writeFileString(
          join(f.root, "pnpm-workspace.yaml"),
          "packages:\n  - instances/*\n",
        ),
      );
      const folder = join(f.root, "instances/factory");
      const { stdout } = yield* Effect.promise(() =>
        exec(process.execPath, [cli, folder], {
          cwd: f.root,
          env: {
            ...f.env,
            PATH: environmentPATH2,
            npm_config_audit: "false",
            npm_config_registry: `http://127.0.0.1:${port}`,
            pnpm_config_registry: `http://127.0.0.1:${port}`,
          },
          timeout: 30_000,
        }),
      );
      assert.include(stdout, installer === "npm" ? "npm run usine -- up" : "pnpm usine up");
      const lockfile = installer === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
      const actual4 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(folder, lockfile)),
      );
      assert.include(actual4, "@usine/server");
      const actual5 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(folder, "node_modules/@usine/server/package.json")),
      );
      assert.deepEqual(parseJson(actual5), manifest);
      const actual6 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readDirectory(f.root),
      );
      assert.notInclude(actual6, lockfile);
      const actual7 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readDirectory(f.root),
      );
      assert.notInclude(actual7, "node_modules");
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  60_000,
);

it.live.each([
  ["npm", "INSTALL_FAILURE", "Installation exited with status 42"],
  ["npm", "NO_LOCKFILE", "Installation did not write package-lock.json"],
  ["pnpm", "INSTALL_FAILURE", "Installation exited with status 42"],
  ["pnpm", "NO_LOCKFILE", "Installation did not write pnpm-lock.yaml"],
] as const)("reports %s %s without claiming setup succeeded", ([installer, variable, message]) =>
  Effect.gen(function* () {
    const f = yield* fixture(installer);
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.remove(f.root, { recursive: true, force: true }),
      ).pipe(Effect.orDie),
    );
    yield* Effect.promise(() =>
      rejects(
        exec(process.execPath, [cli, f.folder], {
          env: { ...f.env, [variable]: "1" },
          timeout: 30_000,
        }),
        new RegExp(
          `${message}.*${installer} install${installer === "pnpm" ? " --ignore-workspace" : " --workspaces=false"} in this folder`,
        ),
      ),
    );
    const actual8 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
      fileSystem.readFileString(join(f.folder, "package.json")),
    );
    assert.equal(decodeManifest(actual8).dependencies["@usine/server"], release.version);
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.live(
  "shows help and rejects missing arguments and unsupported installers before writing files",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("yarn");
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
          fileSystem.remove(f.root, { recursive: true, force: true }),
        ).pipe(Effect.orDie),
      );
      assert.include((yield* Effect.promise(() => f.create("--help"))).stdout, "create-usine");
      yield* Effect.promise(() => rejects(f.create()));
      yield* Effect.promise(() => rejects(f.create(f.folder), /Use npm create usine/));
      const actual9 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readDirectory(f.root),
      );
      assert.deepEqual(actual9, ["bin"]);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);

const freePort = () =>
  (() => {
    const completion = Deferred.makeUnsafe<number>();
    const resolve = (value: number) => {
      Deferred.doneUnsafe(completion, Effect.succeed(value));
    };
    const reject = (error: Error) => {
      Deferred.doneUnsafe(completion, Effect.die(error));
    };
    const listener = createServer();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      // Node event callbacks decode their arguments synchronously.
      // @effect-diagnostics-next-line schemaSync:off
      const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
        listener.address(),
      );
      listener.close(() => resolve(address.port));
    });
    return Deferred.await(completion);
  })();

it.live(
  "starts the scaffolded folder detached in setup mode with one empty revision and resumes it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => f.usine("stop", "--force", "--timeout", "10")).pipe(
          Effect.ensuring(
            Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
              fileSystem.remove(f.root, { recursive: true, force: true }),
            ).pipe(Effect.orDie),
          ),
        ),
      );
      yield* Effect.promise(() => f.create(f.folder));
      const port = yield* freePort();
      const args = ["up", "--detach", "--port", String(port), "--allow-volatile-instance"];
      yield* Effect.promise(() => f.usine(...args));
      const token = (yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(f.folder, ".usine/admin-token")),
      )).trim();
      // `up --detach` returns once the port answers. The startup listener answers 503 with
      // `retry-after` until the setup routes are installed.
      const response = yield* webRequest(`http://127.0.0.1:${port}/api/setup`, {
        headers: { authorization: `Bearer ${token}` },
      }).pipe(
        Effect.repeat({
          while: (answer) => answer.status === 503,
          schedule: Schedule.spaced("250 millis"),
          times: 120,
        }),
      );
      assert.equal(response.status, 200);
      const actual10 = yield* Effect.promise(() => response.json());
      assert.deepEqual(actual10, { _tag: "NoApp" });
      const actual11 = yield* Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
        fileSystem.readFileString(join(f.folder, ".usine/usine.log")),
      );
      assert.include(actual11, "running in setup mode");
      yield* Effect.promise(() => f.usine("stop"));
      yield* Effect.promise(() => f.usine(...args));
      yield* Effect.promise(() => f.usine("stop"));
      const database = new DatabaseSync(join(f.folder, ".usine/runtime.sqlite"), {
        readOnly: true,
      });
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
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, FetchHttpClient.layer))),
  60_000,
);

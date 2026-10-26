import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { InstanceDirectory } from "@usine/core/instance";
import { Config, ConfigProvider, Effect, Option } from "effect";
import { afterEach, assert, describe, it } from "vitest";
import { instanceEnvironment } from "../../src/instance/environment.ts";

const folders: Array<string> = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const instanceFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "usine-environment-"));
  folders.push(folder);
  return InstanceDirectory.make(folder);
};

const shell = ConfigProvider.fromEnv({ env: { TOKEN_B: "from-shell" } });

const read = (
  directory: InstanceDirectory,
  names: ReadonlyArray<string>,
  environment: ConfigProvider.ConfigProvider = shell,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* instanceEnvironment(directory, environment);
      return yield* Effect.forEach(names, (name) =>
        Config.option(Config.string(name)).parse(provider),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

describe("instance environment", () => {
  it("fills the variables that the environment lacks from .env, and keeps the ones it sets", async () => {
    const directory = instanceFolder();
    writeFileSync(
      join(directory, ".env"),
      ["# gateway", "export TOKEN_A=from-file", 'TOKEN_B="from-file"', ""].join("\n"),
    );

    const [a, b, absent] = await read(directory, ["TOKEN_A", "TOKEN_B", "TOKEN_C"]);

    assert.deepStrictEqual(a, Option.some("from-file"));
    assert.deepStrictEqual(b, Option.some("from-shell"));
    assert.deepStrictEqual(absent, Option.none());
  });

  it("fills a variable from .env when the environment sets only a longer name it prefixes", async () => {
    const directory = instanceFolder();
    writeFileSync(join(directory, ".env"), "TOKEN=from-file\nTOKEN_OTHER=from-file\n");
    const environment = ConfigProvider.fromEnv({ env: { TOKEN_OTHER: "from-shell" } });

    const [token, other] = await read(directory, ["TOKEN", "TOKEN_OTHER"], environment);

    assert.deepStrictEqual(token, Option.some("from-file"));
    assert.deepStrictEqual(other, Option.some("from-shell"));
  });

  it("reads the environment alone without .env, and refuses a .env it can't read", async () => {
    const directory = instanceFolder();
    const [b] = await read(directory, ["TOKEN_B"]);
    assert.deepStrictEqual(b, Option.some("from-shell"));

    mkdirSync(join(directory, ".env"));
    const error = await Effect.runPromise(
      instanceEnvironment(directory, shell).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );
    assert.strictEqual(error._tag, "EnvironmentFileError");
    assert.strictEqual(error.path, join(directory, ".env"));
  });
});

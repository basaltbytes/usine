import { Effect, Option } from "effect";
import { assert, describe, it } from "vitest";
import {
  EnginePin,
  bumpPins,
  compareVersions,
  installedInInstance,
  parseManifest,
  serverPin,
} from "../../src/instance/manifest.ts";

const parse = (text: string, lockfiles: ReadonlyArray<string> = []) =>
  Effect.runPromise(parseManifest("/factory/package.json", text, lockfiles));

const pinned = `{
  "name": "my-factory",
  "private": true,
  "dependencies": {
    "@usine/server": "0.3.0",
    "@usine/gateway":"0.2.1",
    "left-pad": "1.3.0"
  },
  "devDependencies": { "@usine/executor": "link:../usine/packages/executor" }
}
`;

describe("instance manifest", () => {
  it("reads the registry pins of @usine packages and the package manager", async () => {
    const manifest = await parse(pinned, ["pnpm-lock.yaml"]);
    assert.deepStrictEqual(
      manifest.pins.map(({ name, spec }) => [name, spec]),
      [
        ["@usine/server", "0.3.0"],
        ["@usine/gateway", "0.2.1"],
      ],
    );
    assert.deepStrictEqual(
      Option.map(serverPin(manifest), ({ spec }) => spec),
      Option.some("0.3.0"),
    );
    assert.strictEqual(manifest.packageManager, "pnpm");
    assert.deepStrictEqual(manifest.linkedServer, Option.none());
  });

  it("prefers the packageManager field and reports a server linked to a checkout", async () => {
    const manifest = await parse(
      JSON.stringify({
        packageManager: "yarn@4.5.0",
        dependencies: { "@usine/server": "link:../usine.dev/apps/server" },
      }),
      ["package-lock.json"],
    );
    assert.strictEqual(manifest.packageManager, "yarn");
    assert.deepStrictEqual(serverPin(manifest), Option.none());
    assert.deepStrictEqual(manifest.linkedServer, Option.some("link:../usine.dev/apps/server"));
    assert.strictEqual((await parse("{}")).packageManager, "npm");
  });

  it("rejects package.json text that is not a JSON object with string dependencies", async () => {
    const error = await Effect.runPromise(
      parseManifest("/factory/package.json", '{"dependencies": {"a": 1}}', []).pipe(Effect.flip),
    );
    assert.strictEqual(error._tag, "InstanceManifestError");
    assert.strictEqual(error.path, "/factory/package.json");
  });

  it("moves each pin to its new version and keeps the rest of the file as written", async () => {
    const manifest = await parse(pinned);
    const bumped = bumpPins(
      pinned,
      manifest.pins,
      new Map([
        ["@usine/server", "0.4.0"],
        ["@usine/gateway", "0.2.2"],
      ]),
    );
    assert.strictEqual(
      bumped,
      pinned
        .replace('"0.3.0"', '"0.4.0"')
        .replace('"@usine/gateway":"0.2.1"', '"@usine/gateway":"0.2.2"'),
    );
    assert.strictEqual(
      bumpPins(pinned, [new EnginePin({ name: "@usine/server", spec: "0.3.0" })], new Map()),
      pinned,
    );
  });

  it("tells an engine installed in the instance from one outside it", () => {
    assert.isTrue(
      installedInInstance(
        "/factory",
        "/factory/node_modules/.pnpm/@usine+server@0.3.0/node_modules/@usine/server/dist/main.js",
      ),
    );
    assert.isFalse(installedInInstance("/factory", "/code/usine.dev/apps/server/dist/main.js"));
    assert.isFalse(installedInInstance("/factory", "/factory/node_modules"));
    assert.isFalse(
      installedInInstance("/factory", "/factory-two/node_modules/@usine/server/dist/main.js"),
    );
  });

  it("orders semantic versions, with a prerelease before its release", () => {
    assert.isAbove(compareVersions("0.4.0", "0.3.9"), 0);
    assert.isAbove(compareVersions("0.10.0", "0.9.0"), 0);
    assert.isBelow(compareVersions("1.0.0-rc.2", "1.0.0"), 0);
    assert.isBelow(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), 0);
    assert.strictEqual(compareVersions("0.3.0", "0.3.0"), 0);
    assert.strictEqual(compareVersions("latest", "0.3.0"), 0);
  });
});

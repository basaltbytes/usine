import { isAbsolute, join, relative } from "node:path";
import { Effect, FileSystem, Option, Schema } from "effect";

/** The package manager that installs the instance's dependencies. */
export const PackageManager = Schema.Literals(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = typeof PackageManager.Type;

const LOCKFILES: ReadonlyArray<readonly [PackageManager, string]> = [
  ["pnpm", "pnpm-lock.yaml"],
  ["npm", "package-lock.json"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
];

const Dependencies = Schema.Record(Schema.String, Schema.String);

const PackageJson = Schema.fromJsonString(
  Schema.Struct({
    packageManager: Schema.optionalKey(Schema.String),
    dependencies: Schema.optionalKey(Dependencies),
    devDependencies: Schema.optionalKey(Dependencies),
    optionalDependencies: Schema.optionalKey(Dependencies),
  }),
);

/** A dependency spec that doesn't resolve on a registry, such as `link:../usine/apps/server`. */
const LOCAL_SPEC = /^(?:link:|file:|workspace:|portal:|git\+|git:|github:|https?:|\.|\/|~)/u;

/** A `@usine/*` dependency of the instance with a registry spec. */
export class EnginePin extends Schema.Class<EnginePin>("@usine/server/EnginePin")({
  name: Schema.NonEmptyString,
  spec: Schema.NonEmptyString,
}) {}

/** The instance folder's `package.json`, as `usine upgrade` reads it. */
export class InstanceManifest extends Schema.Class<InstanceManifest>(
  "@usine/server/InstanceManifest",
)({
  path: Schema.String,
  text: Schema.String,
  /** The `@usine/*` dependencies with a registry spec. */
  pins: Schema.Array(EnginePin),
  /** The spec of `@usine/server` if it points at a local folder instead of a registry version. */
  linkedServer: Schema.Option(Schema.String),
  packageManager: PackageManager,
  /** The lockfiles that exist next to `package.json`. */
  lockfiles: Schema.Array(Schema.String),
}) {}

/** The instance's `package.json` couldn't be read or parsed. */
export class InstanceManifestError extends Schema.TaggedError<InstanceManifestError>(
  "@usine/server/InstanceManifestError",
)("InstanceManifestError", { path: Schema.String, reason: Schema.String }) {}

export const SERVER_PACKAGE = "@usine/server";

const packageManagerOf = (field: string | undefined, lockfiles: ReadonlyArray<string>) => {
  const named = Schema.decodeUnknownOption(PackageManager)(field?.split("@")[0]);
  if (Option.isSome(named)) return named.value;
  const found = LOCKFILES.find(([, file]) => lockfiles.includes(file));
  return found === undefined ? "npm" : found[0];
};

/** Parses `package.json` text. Fails with the parse error as `reason`. */
export const parseManifest = (
  path: string,
  text: string,
  lockfiles: ReadonlyArray<string>,
): Effect.Effect<InstanceManifest, InstanceManifestError> =>
  Schema.decodeUnknownEffect(PackageJson)(text).pipe(
    Effect.mapError((error) => new InstanceManifestError({ path, reason: error.message })),
    Effect.map((manifest) => {
      const dependencies = [
        ...Object.entries(manifest.dependencies ?? {}),
        ...Object.entries(manifest.devDependencies ?? {}),
        ...Object.entries(manifest.optionalDependencies ?? {}),
      ].filter(([name]) => name.startsWith("@usine/"));
      const server = dependencies.find(([name]) => name === SERVER_PACKAGE);
      return new InstanceManifest({
        path,
        text,
        pins: dependencies
          .filter(([, spec]) => spec !== "" && !LOCAL_SPEC.test(spec))
          .map(([name, spec]) => new EnginePin({ name, spec })),
        linkedServer:
          server !== undefined && LOCAL_SPEC.test(server[1])
            ? Option.some(server[1])
            : Option.none(),
        packageManager: packageManagerOf(manifest.packageManager, lockfiles),
        lockfiles,
      });
    }),
  );

/** Reads the instance's `package.json`, or returns `None` if the folder has none. */
export const readManifest = Effect.fn("Instance.readManifest")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = join(directory, "package.json");
  const failure = (error: { readonly message: string }) =>
    new InstanceManifestError({ path, reason: error.message });
  if (!(yield* fileSystem.exists(path).pipe(Effect.mapError(failure)))) {
    return Option.none<InstanceManifest>();
  }
  const text = yield* fileSystem.readFileString(path).pipe(Effect.mapError(failure));
  const lockfiles: Array<string> = [];
  for (const [, file] of LOCKFILES) {
    if (yield* fileSystem.exists(join(directory, file)).pipe(Effect.orElseSucceed(() => false))) {
      lockfiles.push(file);
    }
  }
  return Option.some(yield* parseManifest(path, text, lockfiles));
});

/** The pin of `@usine/server`, if the manifest pins it to a registry version. */
export const serverPin = (manifest: InstanceManifest): Option.Option<EnginePin> =>
  Option.fromUndefinedOr(manifest.pins.find(({ name }) => name === SERVER_PACKAGE));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Returns `text` with each pin's spec replaced by its version in `versions`, formatting intact. */
export const bumpPins = (
  text: string,
  pins: ReadonlyArray<EnginePin>,
  versions: ReadonlyMap<string, string>,
): string =>
  pins.reduce((current, { name, spec }) => {
    const version = versions.get(name);
    if (version === undefined) return current;
    const entry = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*)"${escapeRegExp(spec)}"`, "gu");
    return current.replace(entry, `$1"${version}"`);
  }, text);

/** Whether `script` is inside the instance's `node_modules`. Both paths must be real paths. */
export const installedInInstance = (directory: string, script: string): boolean => {
  const path = relative(join(directory, "node_modules"), script);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

/** Resolves `path` through symbolic links, or returns it unchanged if it can't. */
export const realPathOrSelf = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.realPath(path)).pipe(
    Effect.orElseSucceed(() => path),
  );

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/u;

/**
 * Compares two semantic versions: negative if `left` is older, positive if newer, zero if equal or
 * if either doesn't parse.
 */
export const compareVersions = (left: string, right: string): number => {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (a === null || b === null) return 0;
  for (const index of [1, 2, 3]) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  const [preA, preB] = [a[4], b[4]];
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA.localeCompare(preB, "en", { numeric: true });
};

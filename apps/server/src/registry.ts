import { Effect, Schema } from "effect";
import { runCommand } from "./command.ts";

const NPM_VIEW_TIMEOUT = "30 seconds";

/** The registry has no version of the package that matches the spec, or npm couldn't ask it. */
export class PackageLookupError extends Schema.TaggedError<PackageLookupError>(
  "@usine/server/PackageLookupError",
)("PackageLookupError", {
  name: Schema.String,
  spec: Schema.String,
  reason: Schema.String,
}) {}

const Versions = Schema.fromJsonString(Schema.Union([Schema.String, Schema.Array(Schema.String)]));
const Dependencies = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

/** Runs `npm view <name>@<spec> <field> --json` in `directory`, so its `.npmrc` applies. */
const npmView = (directory: string, name: string, spec: string, field: string) =>
  runCommand("npm", ["view", `${name}@${spec}`, field, "--json"], directory, NPM_VIEW_TIMEOUT).pipe(
    Effect.map(({ stdout }) => stdout.trim()),
    Effect.mapError((error) => new PackageLookupError({ name, spec, reason: error.reason })),
  );

/**
 * Returns the version that `spec`, a version, range, or dist-tag, resolves to on the registry: the
 * highest one for a range.
 */
export const resolveVersion = Effect.fn("Registry.resolveVersion")(function* (
  directory: string,
  name: string,
  spec: string,
) {
  yield* Effect.annotateCurrentSpan({ name, spec });
  const output = yield* npmView(directory, name, spec, "version");
  const decoded = yield* Schema.decodeUnknownEffect(Versions)(output).pipe(
    Effect.mapError(
      () => new PackageLookupError({ name, spec, reason: "no published version matches" }),
    ),
  );
  const versions = Schema.is(Schema.String)(decoded) ? [decoded] : decoded;
  const version = versions.at(-1);
  if (version === undefined) {
    return yield* new PackageLookupError({ name, spec, reason: "no published version matches" });
  }
  return version;
});

/** Returns the published dependencies of `name@version`, with their version specs. */
export const dependenciesOf = Effect.fn("Registry.dependenciesOf")(function* (
  directory: string,
  name: string,
  version: string,
) {
  const output = yield* npmView(directory, name, version, "dependencies");
  if (output === "") return {};
  return yield* Schema.decodeUnknownEffect(Dependencies)(output).pipe(
    Effect.mapError(
      (error) => new PackageLookupError({ name, spec: version, reason: error.message }),
    ),
  );
});

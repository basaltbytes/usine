import { Instance } from "@usine/core";
import { Config, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import { AppCredentials, AppId, GitHubCredentials, PrivateKey } from "./model.ts";

export const GITHUB_APP_SECRETS_PATH = ".usine/github-app.json";

export class EnvironmentCredentialsError extends Schema.TaggedError<EnvironmentCredentialsError>(
  "@usine/github/EnvironmentCredentialsError",
)("EnvironmentCredentialsError", {
  message: Schema.NonEmptyString,
}) {}

export const SecretsFileReason = Schema.Literals(["read", "permissions", "parse"]);
export type SecretsFileReason = typeof SecretsFileReason.Type;

export class SecretsFileError extends Schema.TaggedError<SecretsFileError>(
  "@usine/github/SecretsFileError",
)("SecretsFileError", {
  path: Schema.NonEmptyString,
  reason: SecretsFileReason,
  message: Schema.NonEmptyString,
}) {}

export const LocalSecretsError = Schema.Union([EnvironmentCredentialsError, SecretsFileError]);
export type LocalSecretsError = typeof LocalSecretsError.Type;

const AppIdFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(AppId));
const FilePrivateKey = Schema.RedactedFromValue(PrivateKey, {
  label: "GitHub App private key",
  disallowEncode: true,
});
const AppCredentialsFile = Schema.Struct({ appId: AppId, privateKey: FilePrivateKey }).pipe(
  Schema.encodeKeys({ appId: "app_id", privateKey: "private_key" }),
);
const decodeAppId = Schema.decodeUnknownEffect(AppIdFromString);
const decodePrivateKey = Schema.decodeUnknownEffect(PrivateKey);
const decodeCredentialsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AppCredentialsFile));

const environmentError = () =>
  new EnvironmentCredentialsError({
    message:
      "USINE_GITHUB_APP_ID and USINE_GITHUB_PRIVATE_KEY must contain valid GitHub App credentials",
  });

/**
 * Load the orchestrator's App credentials. Each environment variable wins
 * over its file field; when both are present the file is not touched.
 */
export const loadLocalCredentials = Effect.fn("GitHubCredentials.loadLocal")(function* (
  root: Instance.Directory,
) {
  const rawEnvironment = yield* Effect.all({
    appId: Config.option(Config.string("USINE_GITHUB_APP_ID")),
    privateKey: Config.option(Config.redacted("USINE_GITHUB_PRIVATE_KEY")),
  }).pipe(Effect.mapError(environmentError));

  const environmentAppId = Option.isSome(rawEnvironment.appId)
    ? Option.some(
        yield* decodeAppId(rawEnvironment.appId.value).pipe(Effect.mapError(environmentError)),
      )
    : Option.none<AppId>();
  const environmentPrivateKey = Option.isSome(rawEnvironment.privateKey)
    ? Option.some(
        Redacted.make(
          yield* decodePrivateKey(Redacted.value(rawEnvironment.privateKey.value)).pipe(
            Effect.mapError(environmentError),
          ),
          { label: "GitHub App private key" },
        ),
      )
    : Option.none<Redacted.Redacted<PrivateKey>>();

  if (Option.isSome(environmentAppId) && Option.isSome(environmentPrivateKey)) {
    return new AppCredentials({
      appId: environmentAppId.value,
      privateKey: environmentPrivateKey.value,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretsPath = path.join(root, GITHUB_APP_SECRETS_PATH);
  const info = yield* fileSystem.stat(secretsPath).pipe(
    Effect.mapError(
      () =>
        new SecretsFileError({
          path: secretsPath,
          reason: "read",
          message: `Could not read GitHub App secrets at ${secretsPath}`,
        }),
    ),
  );
  if (info.type !== "File" || (info.mode & 0o777) !== 0o600) {
    return yield* new SecretsFileError({
      path: secretsPath,
      reason: "permissions",
      message: `GitHub App secrets must be a regular 0600 file: ${secretsPath}`,
    });
  }
  const source = yield* fileSystem.readFileString(secretsPath).pipe(
    Effect.mapError(
      () =>
        new SecretsFileError({
          path: secretsPath,
          reason: "read",
          message: `Could not read GitHub App secrets at ${secretsPath}`,
        }),
    ),
  );
  const file = yield* decodeCredentialsFile(source, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      () =>
        new SecretsFileError({
          path: secretsPath,
          reason: "parse",
          message: `GitHub App secrets are invalid at ${secretsPath}`,
        }),
    ),
  );
  return new AppCredentials({
    appId: Option.getOrElse(environmentAppId, () => file.appId),
    privateKey: Option.getOrElse(environmentPrivateKey, () => file.privateKey),
  });
});

export const localSecretsLayer = (
  root: Instance.Directory,
): Layer.Layer<GitHubCredentials, LocalSecretsError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(GitHubCredentials, loadLocalCredentials(root));

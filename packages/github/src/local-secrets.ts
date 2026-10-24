import { InstanceDirectory } from "@usine/core/instance";
import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { AppCredentials, AppId, GitHubCredentials, RedactedPrivateKey } from "./credentials.ts";

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

/** Each variable is optional; a set but invalid one is an error, not a fallback to the file. */
const environment = Config.all({
  appId: Config.option(Config.schema(AppIdFromString, "USINE_GITHUB_APP_ID")),
  privateKey: Config.option(Config.schema(RedactedPrivateKey, "USINE_GITHUB_PRIVATE_KEY")),
});

const AppCredentialsFile = Schema.fromJsonString(
  Schema.Struct({ appId: AppId, privateKey: RedactedPrivateKey }).pipe(
    Schema.encodeKeys({ appId: "app_id", privateKey: "private_key" }),
  ),
);
const decodeCredentialsFile = Schema.decodeUnknownEffect(AppCredentialsFile);

const readSecretsFile = Effect.fn("GitHubCredentials.readSecretsFile")(function* (
  root: InstanceDirectory,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretsPath = path.join(root, GITHUB_APP_SECRETS_PATH);
  const fail = (reason: SecretsFileReason, message: string) =>
    new SecretsFileError({ path: secretsPath, reason, message });
  const unreadable = () => fail("read", `Could not read GitHub App secrets at ${secretsPath}`);

  const info = yield* fileSystem.stat(secretsPath).pipe(Effect.mapError(unreadable));
  if (info.type !== "File" || (info.mode & 0o777) !== 0o600) {
    return yield* fail(
      "permissions",
      `${secretsPath} must be a regular file with mode 0600. Run chmod 600 ${secretsPath}.`,
    );
  }
  const source = yield* fileSystem.readFileString(secretsPath).pipe(Effect.mapError(unreadable));
  return yield* decodeCredentialsFile(source, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() =>
      fail("parse", `${secretsPath} is invalid. It must be JSON with only app_id and private_key.`),
    ),
  );
});

/**
 * Loads the orchestrator's App credentials. An environment variable overrides its file field,
 * and the file isn't read if both variables are set.
 */
export const loadLocalCredentials = Effect.fn("GitHubCredentials.loadLocal")(function* (
  root: InstanceDirectory,
) {
  const env = yield* environment.pipe(
    Effect.mapError(
      () =>
        new EnvironmentCredentialsError({
          message:
            "USINE_GITHUB_APP_ID or USINE_GITHUB_PRIVATE_KEY is invalid. Set USINE_GITHUB_APP_ID to the numeric App ID and USINE_GITHUB_PRIVATE_KEY to the App's PEM private key.",
        }),
    ),
  );
  if (Option.isSome(env.appId) && Option.isSome(env.privateKey)) {
    return new AppCredentials({ appId: env.appId.value, privateKey: env.privateKey.value });
  }
  const file = yield* readSecretsFile(root);
  return new AppCredentials({
    appId: Option.getOrElse(env.appId, () => file.appId),
    privateKey: Option.getOrElse(env.privateKey, () => file.privateKey),
  });
});

export const localSecretsLayer = (
  root: InstanceDirectory,
): Layer.Layer<GitHubCredentials, LocalSecretsError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(GitHubCredentials, loadLocalCredentials(root));

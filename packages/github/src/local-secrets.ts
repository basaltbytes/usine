import { InstanceDirectory } from "@usine/core/instance";
import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { AppCredentials, AppId, GitHubCredentials, RedactedPrivateKey } from "./credentials.ts";

/** The credential file path relative to the instance directory; the file must have mode 0600 (ADR 0011). */
export const GITHUB_APP_SECRETS_PATH = ".usine/github-app.json";

/** An invalid App ID or private key in the environment; loading fails instead of using the file value. */
export class EnvironmentCredentialsError extends Schema.TaggedError<EnvironmentCredentialsError>(
  "@usine/github/EnvironmentCredentialsError",
)("EnvironmentCredentialsError", {
  /** Instructions for correcting `USINE_GITHUB_APP_ID` or `USINE_GITHUB_PRIVATE_KEY`, without their values. */
  message: Schema.NonEmptyString,
}) {}

/** A secrets file failure: `read` for inaccessible files, `permissions` for a non-file or mode other than 0600, or `parse` for invalid credentials or JSON. */
export const SecretsFileReason = Schema.Literals(["read", "permissions", "parse"]);
export type SecretsFileReason = typeof SecretsFileReason.Type;

/** A credential file that cannot be read, does not have mode 0600, or fails JSON or credential validation. */
export class SecretsFileError extends Schema.TaggedError<SecretsFileError>(
  "@usine/github/SecretsFileError",
)("SecretsFileError", {
  /** The resolved credential file path under the instance directory. */
  path: Schema.NonEmptyString,
  /** The file access, permissions, or parsing failure category. */
  reason: SecretsFileReason,
  /** An operator-facing explanation that does not include credential contents. */
  message: Schema.NonEmptyString,
}) {}

/** A failure to load App credentials from environment variables or the instance's secrets file. */
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
 * and the file isn't read if both variables are set. `root` is the instance directory containing
 * `.usine/github-app.json`. The overrides are `USINE_GITHUB_APP_ID` and
 * `USINE_GITHUB_PRIVATE_KEY`; an invalid override fails even if the file is valid. When needed,
 * the file must be a regular file with mode 0600 and JSON containing only `app_id` and
 * `private_key`. Failures use `EnvironmentCredentialsError` or `SecretsFileError` (ADR 0011).
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

/** Provides App credentials loaded once from `root`, the instance directory, and environment overrides. Requires file and path services; credential loading failures fail layer construction. */
export const localSecretsLayer = (
  root: InstanceDirectory,
): Layer.Layer<GitHubCredentials, LocalSecretsError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(GitHubCredentials, loadLocalCredentials(root));

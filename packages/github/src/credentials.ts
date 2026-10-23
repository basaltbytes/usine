import { Context, Schema } from "effect";

/** The numeric GitHub App ID included in signed App JWTs. */
export const AppId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("GitHubAppId"),
);
export type AppId = typeof AppId.Type;

/** A PEM-encoded RSA private key for the GitHub App. */
export const PrivateKey = Schema.NonEmptyString.check(
  Schema.isPattern(
    /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/u,
    { message: "Expected a PEM-encoded RSA private key" },
  ),
).pipe(Schema.brand("GitHubAppPrivateKey"));
export type PrivateKey = typeof PrivateKey.Type;

/** The App private key, redacted in diagnostics and not encodable. */
export const RedactedPrivateKey = Schema.RedactedFromValue(PrivateKey, { disallowEncode: true });

/** The App credentials, kept by the orchestrator and never passed to a Worker. */
export class AppCredentials extends Schema.Class<AppCredentials>("@usine/github/AppCredentials")({
  appId: AppId,
  privateKey: RedactedPrivateKey,
}) {}

/** The service that provides `AppCredentials`. */
export class GitHubCredentials extends Context.Service<GitHubCredentials, AppCredentials>()(
  "@usine/github/GitHubCredentials",
) {}

/** The error when the App private key can't sign, raised once when the App layer is built. */
export class AppAuthenticationError extends Schema.TaggedError<AppAuthenticationError>(
  "@usine/github/AppAuthenticationError",
)("AppAuthenticationError", {
  message: Schema.NonEmptyString,
}) {}

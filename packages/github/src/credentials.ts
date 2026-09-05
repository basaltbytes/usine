import { Context, Schema } from "effect";

/** The numeric GitHub App identity included in signed App JWTs. */
export const AppId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("GitHubAppId"),
);
export type AppId = typeof AppId.Type;

/** A PEM-encoded RSA private key used to authenticate the GitHub App. */
export const PrivateKey = Schema.NonEmptyString.check(
  Schema.isPattern(
    /^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/u,
    { message: "Expected a PEM-encoded RSA private key" },
  ),
).pipe(Schema.brand("GitHubAppPrivateKey"));
export type PrivateKey = typeof PrivateKey.Type;

/** An App signing key that stays redacted in diagnostics and cannot be encoded. */
export const RedactedPrivateKey = Schema.RedactedFromValue(PrivateKey, { disallowEncode: true });

/** The App credentials the orchestrator keeps and never passes to a worker. */
export class AppCredentials extends Schema.Class<AppCredentials>("@usine/github/AppCredentials")({
  appId: AppId,
  privateKey: RedactedPrivateKey,
}) {}

/** Supplies `AppCredentials`, so where credentials come from stays separate from how the App uses them. */
export class GitHubCredentials extends Context.Service<GitHubCredentials, AppCredentials>()(
  "@usine/github/GitHubCredentials",
) {}

/** The App private key cannot sign. Raised once, when the App layer is built. */
export class AppAuthenticationError extends Schema.TaggedError<AppAuthenticationError>(
  "@usine/github/AppAuthenticationError",
)("AppAuthenticationError", {
  message: Schema.NonEmptyString,
}) {}

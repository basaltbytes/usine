import { InstanceScope } from "@usine/core/access";
import { GitHubUserId, PermissionGrant, administratorPermissions } from "@usine/core/access";
import { OperatorActor, OperatorLogin } from "@usine/core/operator";
import { type Brand, Data, Effect, Option, Schema } from "effect";

export { GitHubUserId } from "@usine/core/access";
export class GitHubIdentity extends Schema.Class<
  GitHubIdentity,
  Brand.Brand<"@usine/server/auth/model/GitHubIdentity">
>("GitHubIdentity")({
  login: OperatorLogin,
  id: GitHubUserId,
}) {}
export class Member extends Schema.Class<Member, Brand.Brand<"@usine/server/auth/model/Member">>(
  "Member",
)({
  ...GitHubIdentity.fields,
  addedAt: Schema.Finite,
  addedBy: OperatorActor,
}) {}
export const TokenId = Schema.NonEmptyString.pipe(Schema.brand("TokenId"));
export type TokenId = typeof TokenId.Type;
/** Identifies the credential of a request: its token ID, or a hash of an instance credential's secret. */
export const CredentialId = Schema.NonEmptyString.pipe(Schema.brand("CredentialId"));
export type CredentialId = typeof CredentialId.Type;
export const TokenHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(
  Schema.brand("TokenHash"),
);
export type TokenHash = typeof TokenHash.Type;
export const TokenName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).pipe(
  Schema.brand("TokenName"),
);
export type TokenName = typeof TokenName.Type;
/** An OpenAPI operation ID, such as `operator.approve`. */
export const OperationId = Schema.String.check(
  Schema.isPattern(/^[a-z]+\.[A-Za-z]+$/u, {
    message: "Expected an operation ID, such as operator.approve",
  }),
).pipe(Schema.brand("OperationId"));
export type OperationId = typeof OperationId.Type;
/** How a scope edit changes a device token's operation ceiling. */
export type OperationCeilingChange = Data.TaggedEnum<{
  Keep: {};
  Remove: {};
  Replace: { readonly operations: ReadonlyArray<OperationId> };
}>;
export const OperationCeilingChange = Data.taggedEnum<OperationCeilingChange>();
/** Reports whether an operation ceiling admits `operation`; `None` admits every operation. */
export const ceilingAdmits = (
  ceiling: Option.Option<ReadonlyArray<OperationId>>,
  operation: string,
): boolean =>
  Option.match(ceiling, {
    onNone: () => true,
    onSome: (operations) => operations.some((allowed) => allowed === operation),
  });
/** A device token without an expiry stores this `expiresAt`. */
export const NO_EXPIRY = Number.MAX_SAFE_INTEGER;
export class InstanceToken extends Schema.Class<
  InstanceToken,
  Brand.Brand<"@usine/server/auth/model/InstanceToken">
>("InstanceToken")({
  id: TokenId,
  memberId: GitHubUserId,
  name: TokenName,
  hash: TokenHash,
  createdAt: Schema.Finite,
  lastUsedAt: Schema.Finite,
  expiresAt: Schema.Finite,
  scopes: Schema.Array(PermissionGrant).pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed([{ permission: "admin", scope: InstanceScope.make() }]),
    ),
    Schema.withConstructorDefault(Effect.succeed(administratorPermissions)),
  ),
  kind: Schema.Literals(["session", "device"]),
  /** The operations a device token may call; `None` allows every operation its scopes permit. */
  operations: Schema.OptionFromOptionalKey(Schema.Array(OperationId)).pipe(
    Schema.withConstructorDefault(Effect.succeedNone),
  ),
}) {
  recordUse(now: number): InstanceToken {
    return now - this.lastUsedAt < 60_000 ? this : InstanceToken.make({ ...this, lastUsedAt: now });
  }
}
export class AuthError extends Schema.TaggedError<
  AuthError,
  Brand.Brand<"@usine/server/auth/model/AuthError">
>()("AuthError", {
  status: Schema.Literals([400, 401, 403, 409, 429, 500, 502, 503]),
  message: Schema.String,
}) {}
export const authFailure = (message: string, status: AuthError["status"] = 401) =>
  AuthError.make({ status, message });

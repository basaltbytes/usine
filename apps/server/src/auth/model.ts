import { InstanceScope } from "@usine/core/access";
import { GitHubUserId, PermissionGrant, administratorPermissions } from "@usine/core/access";
import { OperatorActor, OperatorLogin } from "@usine/core/operator";
import { type Brand, Effect, Schema } from "effect";

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
export const TokenHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)).pipe(
  Schema.brand("TokenHash"),
);
export type TokenHash = typeof TokenHash.Type;
export const TokenName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).pipe(
  Schema.brand("TokenName"),
);
export type TokenName = typeof TokenName.Type;
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

import { OperatorLogin } from "@usine/core/operator";
import { Schema } from "effect";

export const GitHubUserId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("GitHubUserId"),
);
export type GitHubUserId = typeof GitHubUserId.Type;
export class GitHubIdentity extends Schema.Class<GitHubIdentity>("GitHubIdentity")({
  login: OperatorLogin,
  id: GitHubUserId,
}) {}
export class Member extends Schema.Class<Member>("Member")({
  ...GitHubIdentity.fields,
  addedAt: Schema.Number,
  addedBy: OperatorLogin,
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
export class InstanceToken extends Schema.Class<InstanceToken>("InstanceToken")({
  id: TokenId,
  memberId: GitHubUserId,
  name: TokenName,
  hash: TokenHash,
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
  expiresAt: Schema.Number,
  kind: Schema.Literals(["session", "device"]),
}) {}
export class AuthError extends Schema.TaggedError<AuthError>("AuthError")("AuthError", {
  status: Schema.Literals([400, 401, 403, 409, 429, 500, 502, 503]),
  message: Schema.String,
}) {}
export const authFailure = (message: string, status: AuthError["status"] = 401) =>
  new AuthError({ status, message });

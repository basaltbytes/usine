import { Context, type Effect, type Option } from "effect";
import { AuthError, GitHubUserId, InstanceToken, Member, TokenHash, TokenId } from "./model.ts";

export class AuthStore extends Context.Service<
  AuthStore,
  {
    readonly members: Effect.Effect<ReadonlyArray<Member>, AuthError>;
    readonly add: (member: Member, onlyIfEmpty: boolean) => Effect.Effect<void, AuthError>;
    readonly remove: (id: GitHubUserId) => Effect.Effect<void, AuthError>;
    readonly issue: (token: InstanceToken) => Effect.Effect<void, AuthError>;
    readonly authenticate: (
      hash: TokenHash,
      now: number,
    ) => Effect.Effect<
      Option.Option<{ readonly member: Member; readonly token: InstanceToken }>,
      AuthError
    >;
    readonly tokens: (id: GitHubUserId) => Effect.Effect<ReadonlyArray<InstanceToken>, AuthError>;
    readonly revoke: (member: GitHubUserId, token: TokenId) => Effect.Effect<void, AuthError>;
  }
>()("@usine/server/AuthStore") {}

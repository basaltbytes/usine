import { Clock, Effect, Layer, Option } from "effect";
import {
  authFailure,
  type GitHubUserId,
  type InstanceToken,
  Member,
  type TokenId,
} from "./model.ts";
import { AuthStore } from "./store.ts";

export const memoryAuthLayer = Layer.sync(AuthStore, () => {
  const members = new Map<GitHubUserId, Member>();
  const tokens = new Map<TokenId, InstanceToken>();
  return AuthStore.of({
    members: Effect.sync(() =>
      [...members.values()].sort((a, b) => a.addedAt - b.addedAt || a.id - b.id),
    ),
    add: Effect.fn("AuthStore.add")(function* (member, onlyIfEmpty) {
      if (
        (onlyIfEmpty && members.size > 0) ||
        [...members.values()].some(
          (entry) =>
            entry.id === member.id || entry.login.toLowerCase() === member.login.toLowerCase(),
        )
      )
        return yield* authFailure("This member already exists or setup has completed.", 409);
      members.set(member.id, member);
      yield* Effect.logInfo("Member added", { memberId: member.id, actor: member.addedBy });
    }),
    rename: Effect.fn("AuthStore.rename")(function* (identity) {
      yield* Effect.annotateCurrentSpan({ memberId: identity.id });
      const member = members.get(identity.id);
      if (member === undefined)
        return yield* authFailure("This GitHub login is not a member.", 403);
      if (member.login === identity.login) return member;
      if (
        [...members.values()].some(
          (entry) =>
            entry.id !== identity.id && entry.login.toLowerCase() === identity.login.toLowerCase(),
        )
      )
        return yield* authFailure("This GitHub login belongs to another member.", 409);
      const renamed = new Member({ ...member, login: identity.login });
      members.set(identity.id, renamed);
      yield* Effect.logInfo("Member login updated", {
        memberId: identity.id,
        login: identity.login,
      });
      return renamed;
    }),
    remove: Effect.fn("AuthStore.remove")(function* (id) {
      if (members.has(id) && members.size === 1)
        return yield* authFailure("Add another member before removing the last admin.", 409);
      members.delete(id);
      for (const [key, token] of tokens) if (token.memberId === id) tokens.delete(key);
      yield* Effect.logInfo("Member removed", { memberId: id });
    }),
    issue: Effect.fn("AuthStore.issue")(function* (token) {
      if (!members.has(token.memberId))
        return yield* authFailure("This GitHub login is not a member.", 403);
      tokens.set(token.id, token);
    }),
    authenticate: Effect.fn("AuthStore.authenticate")((hash, now) =>
      Effect.sync(() => {
        const token = [...tokens.values()].find(
          (entry) => entry.hash === hash && entry.expiresAt > now,
        );
        if (token === undefined) return Option.none();
        const member = members.get(token.memberId);
        if (member === undefined) return Option.none();
        const used = token.recordUse(now);
        if (used !== token) tokens.set(token.id, used);
        return Option.some({ member, token: used });
      }),
    ),
    tokens: Effect.fn("AuthStore.tokens")(function* (id) {
      yield* Effect.annotateCurrentSpan({ memberId: id });
      const now = yield* Clock.currentTimeMillis;
      let expired = 0;
      for (const [key, token] of tokens) {
        if (token.expiresAt <= now) {
          tokens.delete(key);
          expired++;
        }
      }
      if (expired > 0) yield* Effect.logInfo("Expired instance tokens deleted", { count: expired });
      return [...tokens.values()].filter((token) => token.memberId === id);
    }),
    revoke: Effect.fn("AuthStore.revoke")(function* (member, id) {
      if (tokens.get(id)?.memberId === member) tokens.delete(id);
      yield* Effect.logInfo("Instance token revoked", { memberId: member, tokenId: id });
    }),
  });
});

import { Effect, Layer, Option } from "effect";
import {
  authFailure,
  type GitHubUserId,
  InstanceToken,
  type Member,
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
        const used = new InstanceToken({ ...token, lastUsedAt: now });
        tokens.set(token.id, used);
        return Option.some({ member, token: used });
      }),
    ),
    tokens: Effect.fn("AuthStore.tokens")((id) =>
      Effect.sync(() => [...tokens.values()].filter((token) => token.memberId === id)),
    ),
    revoke: Effect.fn("AuthStore.revoke")(function* (member, id) {
      if (tokens.get(id)?.memberId === member) tokens.delete(id);
      yield* Effect.logInfo("Instance token revoked", { memberId: member, tokenId: id });
    }),
  });
});

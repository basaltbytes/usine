import type { TurnId } from "@usine/core/conversation";
import {
  answeredAt,
  answeredByMember,
  isAllowed,
  type PermissionRequest,
  type PermissionRequestId,
  reportIn,
  revokeGrant,
  type StandingGrant,
  type StandingGrantId,
  useGrant,
} from "@usine/core/permission-request";
import { DateTime, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { PermissionStore, RequestConflict } from "./store.ts";

const byRequestTime = (left: PermissionRequest, right: PermissionRequest) =>
  DateTime.toEpochMillis(left.requestedAt) - DateTime.toEpochMillis(right.requestedAt);

/**
 * Provides an empty permission store in memory. Each layer build has its own state, and writes
 * apply one at a time.
 */
export const memoryPermissionStoreLayer = Layer.effect(
  PermissionStore,
  Effect.gen(function* () {
    const requests = yield* Ref.make(new Map<PermissionRequestId, PermissionRequest>());
    const grants = yield* Ref.make(new Map<StandingGrantId, StandingGrant>());
    const lock = yield* Semaphore.make(1);
    const serialized = lock.withPermits(1);
    const all = Effect.map(Ref.get(requests), (stored) => [...stored.values()].sort(byRequestTime));
    const saveGrant = (grant: StandingGrant) =>
      Ref.update(grants, (stored) => new Map(stored).set(grant.id, grant));
    const updateGrant = (id: StandingGrantId, update: (grant: StandingGrant) => StandingGrant) =>
      Effect.gen(function* () {
        const current = Option.fromUndefinedOr((yield* Ref.get(grants)).get(id));
        if (Option.isNone(current)) return Option.none<StandingGrant>();
        const next = update(current.value);
        yield* saveGrant(next);
        return Option.some(next);
      });

    return PermissionStore.of({
      create: Effect.fn("PermissionStore.create")(function* (request, used) {
        yield* Effect.annotateCurrentSpan({ request: request.id });
        yield* Effect.gen(function* () {
          yield* Ref.update(requests, (stored) => new Map(stored).set(request.id, request));
          if (Option.isSome(used))
            yield* updateGrant(used.value, (grant) => useGrant(grant, request.requestedAt));
        }).pipe(serialized);
      }),
      transition: Effect.fn("PermissionStore.transition")(function* (from, to, grant) {
        yield* Effect.annotateCurrentSpan({ request: from.id, from: from.state._tag });
        yield* Effect.gen(function* () {
          const current = (yield* Ref.get(requests)).get(from.id);
          if (current?.state._tag !== from.state._tag)
            return yield* RequestConflict.make({ request: from.id, expected: from.state._tag });
          yield* Ref.update(requests, (stored) => new Map(stored).set(to.id, to));
          if (Option.isSome(grant)) yield* saveGrant(grant.value);
        }).pipe(serialized);
      }),
      get: (id) =>
        Effect.map(Ref.get(requests), (stored) => Option.fromUndefinedOr(stored.get(id))),
      ofConversation: (conversation) =>
        Effect.map(all, (stored) =>
          stored.filter((request) => request.conversation === conversation),
        ),
      ofTurn: (turn) =>
        Effect.map(all, (stored) => stored.filter((request) => request.turn === turn)),
      running: Effect.map(all, (stored) => stored.filter(isAllowed)),
      unreported: Effect.map(all, (stored) => [
        ...new Set<TurnId>(
          stored
            .filter((request) => answeredByMember(request) && Option.isNone(request.reportedIn))
            .map(({ turn }) => turn),
        ),
      ]),
      report: Effect.fn("PermissionStore.report")(function* (turn, followUp) {
        yield* Ref.update(requests, (stored) => {
          const next = new Map(stored);
          for (const request of stored.values())
            if (request.turn === turn) next.set(request.id, reportIn(request, followUp));
          return next;
        }).pipe(serialized);
      }),
      actions: (limit) =>
        Effect.map(all, (stored) =>
          stored
            .flatMap((request) =>
              request.state._tag === "Waiting" || request.state._tag === "Denied"
                ? []
                : Option.toArray(
                    Option.map(answeredAt(request), (at) => ({
                      request,
                      at: DateTime.toEpochMillis(at),
                    })),
                  ),
            )
            .sort((left, right) => right.at - left.at)
            .slice(0, limit)
            .map(({ request }) => request),
        ),
      grants: Effect.map(Ref.get(grants), (stored) =>
        [...stored.values()]
          .filter(({ revoked }) => Option.isNone(revoked))
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
          ),
      ),
      grant: (id) =>
        Effect.map(Ref.get(grants), (stored) => Option.fromUndefinedOr(stored.get(id))),
      revoke: Effect.fn("PermissionStore.revoke")(function* (id, revocation) {
        yield* Effect.annotateCurrentSpan({ grant: id });
        return yield* updateGrant(id, (grant) => revokeGrant(grant, revocation)).pipe(serialized);
      }),
    });
  }),
);

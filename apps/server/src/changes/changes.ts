import { audienceScope, authorize, expandTarget } from "./policy.ts";
import { ChangeAccess } from "./access.ts";
import type { PermissionGrant } from "@usine/core/access";
import { ChangeBus, type ScopedChange, type ChangeTarget } from "@usine/core/changes";
import { CurrentInstance } from "@usine/orchestrator/current-instance";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Stream,
  Schema,
  SubscriptionRef,
} from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

interface Checks {
  readonly closed: boolean;
  /** The credential checks in progress. */
  readonly running: number;
}

const makeChanges = Effect.gen(function* () {
  const bus = yield* ChangeBus;
  const instances = yield* Effect.serviceOption(CurrentInstance);
  const closing = yield* Deferred.make<void>();
  const checks = yield* SubscriptionRef.make<Checks>({ closed: false, running: 0 });
  const endStreams = Effect.fn("Http.changes.endStreams")(function* () {
    const { running } = yield* SubscriptionRef.getAndUpdate(checks, (current) => ({
      ...current,
      closed: true,
    }));
    yield* Deferred.succeed(closing, undefined);
    yield* Effect.annotateCurrentSpan({ checksInProgress: running });
    yield* SubscriptionRef.changes(checks).pipe(
      Stream.filter((current) => current.running === 0),
      Stream.take(1),
      Stream.runDrain,
    );
    yield* Effect.logInfo("Change streams stopped because their routes closed", {
      checksInProgress: running,
    });
  });
  // When the routes close, streams stop checking credentials and end, before the stores that
  // `ChangeAccess` reads close.
  yield* Effect.addFinalizer(() => endStreams());
  const stream = Effect.fn("Http.changes")(function* (
    request: HttpServerRequest.HttpServerRequest,
    grants: ReadonlyArray<PermissionGrant>,
  ) {
    const access = yield* ChangeAccess;
    // Succeeds with `false`, without a check, once the routes have closed.
    const verify = Effect.acquireUseRelease(
      SubscriptionRef.modify(checks, (current): [boolean, Checks] =>
        current.closed ? [false, current] : [true, { ...current, running: current.running + 1 }],
      ),
      (admitted) =>
        admitted
          ? Effect.as(access, true)
          : Effect.logDebug(
              "Change stream skipped a credential check after its routes closed",
            ).pipe(Effect.as(false)),
      (admitted) =>
        admitted
          ? SubscriptionRef.update(checks, (current) => ({
              ...current,
              running: current.running - 1,
            }))
          : Effect.void,
    );
    const targets = Effect.fn("Http.changes.authorizedTargets")(function* (
      changes: ReadonlyArray<ScopedChange>,
    ) {
      const projects = Option.isSome(instances) ? (yield* instances.value.get).config.projects : [];
      const result = new Map<string, ChangeTarget>();
      const add = (target: ChangeTarget) => result.set(`${target.kind}:${target.id}`, target);
      for (const { audience, target } of changes) {
        const scope = audienceScope(audience, projects);
        if (!authorize(grants, scope)) continue;
        const project = scope._tag === "Project" ? Option.some(scope.project) : Option.none();
        for (const expanded of expandTarget(target, project)) add(expanded);
      }
      return [...result.values()];
    });
    const supplied = request.headers["last-event-id"];
    yield* Effect.logDebug("Change stream opened", { resume: supplied ?? "initial" });
    const frames = Stream.unwrap(
      Effect.gen(function* () {
        const { revision, history, live } = yield* bus.open;
        const suppliedCursor = supplied === undefined ? NaN : Number(supplied);
        const cursor = yield* Ref.make(suppliedCursor);
        const oldest = history[0]?.revision ?? revision + 1;
        const reset =
          !Number.isSafeInteger(suppliedCursor) ||
          suppliedCursor < oldest - 1 ||
          suppliedCursor > revision;
        const frame = (notice: ChangeNotice) =>
          Schema.encodeEffect(Schema.fromJsonString(ChangeNotice))(notice).pipe(
            Effect.orDie,
            Effect.map((data) => `id: ${notice.revision}\nevent: change\ndata: ${data}\n\n`),
          );
        const send = Effect.fn("Http.changes.send")(function* (notice: (typeof history)[number]) {
          const previous = yield* Ref.get(cursor);
          if (notice.revision <= previous) return "";
          yield* Effect.annotateCurrentSpan({ revision: notice.revision });
          if (!(yield* verify)) return "";
          const gap = notice.revision > previous + 1;
          yield* Ref.set(cursor, notice.revision);
          const changes = gap ? [] : yield* targets(notice.changes);
          if (!gap && changes.length === 0) return "";
          yield* Effect.logDebug("Change notice sent", {
            revision: notice.revision,
            reset: gap,
            targets: changes.length,
          });
          return yield* frame(
            ChangeNotice.make({ revision: notice.revision, reset: gap, changes }),
          );
        });
        const initial = reset
          ? Effect.gen(function* () {
              if (!(yield* verify)) return "";
              yield* Ref.set(cursor, revision);
              yield* Effect.logDebug("Change stream reset", {
                revision,
                resume: supplied ?? "initial",
              });
              return (
                (yield* frame(ChangeNotice.make({ revision, reset: true, changes: [] }))) +
                ": heartbeat\n\n"
              );
            })
          : Effect.forEach(
              history.filter((notice) => notice.revision > suppliedCursor),
              send,
            ).pipe(Effect.map((frames) => frames.join("") + ": heartbeat\n\n"));
        // Ends when the routes close, which ends the merge with `live`.
        const heartbeat = Stream.fromEffectRepeat(
          Deferred.await(closing).pipe(
            Effect.andThen(Cause.done()),
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () =>
                Effect.flatMap(verify, (admitted) =>
                  admitted ? Effect.succeed(": heartbeat\n\n") : Cause.done(),
                ),
            }),
          ),
        );
        return Stream.concat(
          Stream.fromEffect(initial),
          Stream.merge(live.pipe(Stream.mapEffect(send)), heartbeat, { haltStrategy: "right" }),
        );
      }),
    ).pipe(
      Stream.filter((frame) => frame.length > 0),
      Stream.tapError((error) =>
        Effect.logWarning("Change stream closed after credential validation failed", { error }),
      ),
      Stream.encodeText,
    );
    return HttpServerResponse.stream(frames, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  });
  return { stream };
});

export class Changes extends Context.Service<Changes, Effect.Success<typeof makeChanges>>()(
  "@usine/server/changes/changes",
) {
  static readonly layer = Layer.effect(Changes, makeChanges);
}

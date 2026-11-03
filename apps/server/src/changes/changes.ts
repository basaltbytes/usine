import { audienceScope, authorize, expandTarget } from "./policy.ts";
import { ChangeAccess } from "./access.ts";
import type { PermissionGrant } from "@usine/core/access";
import { ChangeBus, type ScopedChange, type ChangeTarget } from "@usine/core/changes";
import { CurrentInstance } from "@usine/orchestrator/current-instance";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { Context, Effect, Layer, Option, Ref, Schedule, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

const makeChanges = Effect.gen(function* () {
  const bus = yield* ChangeBus;
  const instances = yield* Effect.serviceOption(CurrentInstance);
  const stream = Effect.fn("Http.changes")(function* (
    request: HttpServerRequest.HttpServerRequest,
    grants: ReadonlyArray<PermissionGrant>,
  ) {
    const verify = yield* ChangeAccess;
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
          `id: ${notice.revision}\nevent: change\ndata: ${JSON.stringify(notice)}\n\n`;
        const send = Effect.fn("Http.changes.send")(function* (notice: (typeof history)[number]) {
          const previous = yield* Ref.get(cursor);
          if (notice.revision <= previous) return "";
          yield* Effect.annotateCurrentSpan({ revision: notice.revision });
          yield* verify;
          const gap = notice.revision > previous + 1;
          yield* Ref.set(cursor, notice.revision);
          const changes = gap ? [] : yield* targets(notice.changes);
          if (!gap && changes.length === 0) return "";
          yield* Effect.logDebug("Change notice sent", {
            revision: notice.revision,
            reset: gap,
            targets: changes.length,
          });
          return frame(ChangeNotice.make({ revision: notice.revision, reset: gap, changes }));
        });
        const initial = reset
          ? Effect.gen(function* () {
              yield* verify;
              yield* Ref.set(cursor, revision);
              yield* Effect.logDebug("Change stream reset", {
                revision,
                resume: supplied ?? "initial",
              });
              return (
                frame(ChangeNotice.make({ revision, reset: true, changes: [] })) + ": heartbeat\n\n"
              );
            })
          : Effect.forEach(
              history.filter((notice) => notice.revision > suppliedCursor),
              send,
            ).pipe(Effect.map((frames) => frames.join("") + ": heartbeat\n\n"));
        const heartbeat = Stream.fromEffectSchedule(
          verify.pipe(Effect.as(": heartbeat\n\n")),
          Schedule.spaced("15 seconds"),
        ).pipe(Stream.drop(1));
        return Stream.concat(
          Stream.fromEffect(initial),
          Stream.merge(live.pipe(Stream.mapEffect(send)), heartbeat),
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
  "@usine/server/Changes",
) {
  static readonly layer = Layer.effect(Changes, makeChanges);
}

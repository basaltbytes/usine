import { ChangeAccess } from "./access.ts";
import { InstanceScope, permits, ProjectScope, type PermissionGrant } from "@usine/core/access";
import { ChangeBus, type ScopedChange, type ChangeTarget } from "@usine/core/changes";
import { ProjectId } from "@usine/core/project";
import { CurrentInstance } from "@usine/orchestrator/current-instance";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
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
        const project =
          audience._tag === "Repository"
            ? projects.find((project) => project.includes(audience.repository))?.id
            : audience._tag === "Project"
              ? audience.project
              : audience._tag === "Loop"
                ? Option.getOrUndefined(SchemaProject(audience.loop.split("/")[0]))
                : undefined;
        const allowed =
          audience._tag === "Readers"
            ? grants.some(({ permission }) => permission === "read" || permission === "admin")
            : permits(
                grants,
                "read",
                project === undefined ? new InstanceScope() : new ProjectScope({ project }),
              );
        if (!allowed) continue;
        add(target);
        if (target.kind === "activity" || target.kind === "navigation") continue;
        if (project !== undefined) add({ kind: "project", id: project });
        add({ kind: "attention", id: "instance" });
        add({ kind: "activity", id: "instance" });
        if (target.kind !== "worker") add({ kind: "navigation", id: "instance" });
      }
      return [...result.values()];
    });
    const supplied = request.headers["last-event-id"];
    yield* Effect.logDebug("Change stream opened", { resume: supplied ?? "initial" });
    const frames = Stream.unwrap(
      Effect.gen(function* () {
        const { revision, history, live } = yield* bus.open;
        let cursor = supplied === undefined ? NaN : Number(supplied);
        const oldest = history[0]?.revision ?? revision + 1;
        const reset = !Number.isSafeInteger(cursor) || cursor < oldest - 1 || cursor > revision;
        const frame = (notice: ChangeNotice) =>
          `id: ${notice.revision}\nevent: change\ndata: ${JSON.stringify(notice)}\n\n`;
        const send = Effect.fn("Http.changes.send")(function* (notice: (typeof history)[number]) {
          if (notice.revision <= cursor) return "";
          yield* Effect.annotateCurrentSpan({ revision: notice.revision });
          yield* verify;
          const gap = notice.revision > cursor + 1;
          cursor = notice.revision;
          const changes = gap ? [] : yield* targets(notice.changes);
          if (!gap && changes.length === 0) return "";
          yield* Effect.logDebug("Change notice sent", {
            revision: cursor,
            reset: gap,
            targets: changes.length,
          });
          return frame(new ChangeNotice({ revision: cursor, reset: gap, changes }));
        });
        const initial = reset
          ? Effect.gen(function* () {
              yield* verify;
              cursor = revision;
              yield* Effect.logDebug("Change stream reset", {
                revision,
                resume: supplied ?? "initial",
              });
              return (
                frame(new ChangeNotice({ revision, reset: true, changes: [] })) + ": heartbeat\n\n"
              );
            })
          : Effect.forEach(
              history.filter((notice) => notice.revision > cursor),
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

const SchemaProject = Schema.decodeUnknownOption(ProjectId);

export class Changes extends Context.Service<Changes, Effect.Success<typeof makeChanges>>()(
  "@usine/server/Changes",
) {
  static readonly layer = Layer.effect(Changes, makeChanges);
}

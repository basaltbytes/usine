import { ChangeAccess } from "./access.ts";
import {
  InstanceScope,
  permits,
  RequestPermissions,
  type PermissionGrant,
} from "@usine/core/access";
import { ChangeNotice } from "@usine/orchestrator/operator/http";
import { Clock, Context, Effect, Layer, Option, Schedule, Stream, SynchronizedRef } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { FactoryBackend } from "../backend.ts";
import { ServerUpgrades } from "../upgrade/control.ts";
import { changedTargets, snapshot, type Snapshot } from "./snapshot.ts";

type Journal = {
  readonly sampledAt: number;
  readonly snapshot: Snapshot;
  readonly revision: number;
  readonly history: ReadonlyArray<ChangeNotice>;
};

/** Keeps bounded replay journals isolated by the request's effective permissions. */
const makeChanges = Effect.gen(function* () {
  const journals = yield* SynchronizedRef.make(new Map<string, Journal>());
  let revision = Date.now();
  const stream = Effect.fn("Http.changes")(function* (
    backend: FactoryBackend["Service"],
    request: HttpServerRequest.HttpServerRequest,
    grants: ReadonlyArray<PermissionGrant>,
  ) {
    const verify = yield* ChangeAccess;
    const key = JSON.stringify(grants);
    const upgrades = yield* Effect.serviceOption(ServerUpgrades);
    const supplied = request.headers["last-event-id"];
    let cursor = supplied === undefined ? undefined : Number(supplied);
    let ticks = 0;
    yield* Effect.logDebug("Change stream opened", { resume: supplied ?? "initial" });
    const read = SynchronizedRef.modifyEffect(journals, (current) =>
      Effect.gen(function* () {
        yield* verify;
        const sampledAt = yield* Clock.currentTimeMillis;
        const previous = current.get(key);
        let journal = previous;
        if (journal === undefined || sampledAt - journal.sampledAt >= 750) {
          const [overview, desk, configuration, upgrade] = yield* Effect.all(
            [
              backend.overview,
              backend.desk,
              backend.configuration,
              permits(grants, "admin", new InstanceScope()) && Option.isSome(upgrades)
                ? upgrades.value.status.pipe(Effect.map(Option.some))
                : Effect.succeed(Option.none()),
            ],
            { concurrency: "unbounded" },
          );
          const next = snapshot(overview, desk, configuration, upgrade);
          const changes = previous === undefined ? [] : changedTargets(previous.snapshot, next);
          const notice =
            changes.length === 0
              ? undefined
              : new ChangeNotice({ revision: ++revision, reset: false, changes });
          journal = {
            sampledAt,
            snapshot: next,
            revision: notice?.revision ?? previous?.revision ?? ++revision,
            history:
              notice === undefined
                ? (previous?.history ?? [])
                : [...(previous?.history ?? []), notice].slice(-256),
          };
        }
        const updated = new Map(current);
        updated.delete(key);
        updated.set(key, journal);
        if (updated.size > 16) {
          const oldestKey = updated.keys().next().value;
          if (oldestKey !== undefined) updated.delete(oldestKey);
        }
        const oldest = journal.history[0]?.revision ?? journal.revision;
        const reset =
          previous === undefined ||
          cursor === undefined ||
          !Number.isSafeInteger(cursor) ||
          cursor < oldest - 1 ||
          cursor > journal.revision;
        const notices = reset
          ? [new ChangeNotice({ revision: journal.revision, reset: true, changes: [] })]
          : journal.history.filter(({ revision }) => revision > (cursor ?? 0));
        cursor = journal.revision;
        if (notices.length > 0)
          yield* Effect.logDebug("Change notices sent", {
            revision: journal.revision,
            notices: notices.length,
            reset,
          });
        const frames = notices.map(
          (notice) => `id: ${notice.revision}\nevent: change\ndata: ${JSON.stringify(notice)}\n\n`,
        );
        if (ticks++ % 15 === 0) frames.push(": heartbeat\n\n");
        return [frames.join(""), updated] as const;
      }),
    );
    const stream = Stream.fromEffectSchedule(read, Schedule.spaced(1_000)).pipe(
      Stream.provideService(RequestPermissions, grants),
      Stream.tapError((error) => Effect.logWarning("Change stream read failed", { error })),
      Stream.encodeText,
    );
    return HttpServerResponse.stream(stream, {
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

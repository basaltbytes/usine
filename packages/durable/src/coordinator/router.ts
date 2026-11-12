import type { AttemptId } from "@usine/core/attempt";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import { InfraFailure } from "@usine/core/attempt/failure";
import { Context, Effect, Layer, Option, Semaphore } from "effect";

import { type AttemptRequest, AttemptRuntime } from "../attempt-runtime.ts";
import { keepNotice } from "../attempt/notices.ts";
import { AttemptJournal, type JournalError } from "./journal.ts";
import { CoordinatorRuntime } from "./runtime.ts";

/** The runtime of Attempts that a Pi parent session coordinates, on pi-durable storage. */
export class PiAttemptRuntime extends Context.Service<
  PiAttemptRuntime,
  AttemptRuntime["Service"]
>()("@usine/durable/coordinator/router/PiAttemptRuntime") {}

const infra = (error: JournalError) => InfraFailure.make({ message: error.message, cause: error });

/**
 * Provides `AttemptRuntime` over the Pi parent's runtime and the event-driven coordinator. An
 * Attempt stays on the runtime that started it: `execute` sends it to the coordinator if the
 * attempt journal has it, to the Pi runtime if pi-durable has it, and otherwise by its
 * `RunSpec.coordinator`. The other operations look the Attempt up in the attempt journal and fall back
 * to the Pi runtime. A Worker notice for an Attempt that neither runtime has yet waits for its
 * `execute` call.
 */
export const routerLayer = Layer.effect(
  AttemptRuntime,
  Effect.gen(function* () {
    const pi = yield* PiAttemptRuntime;
    const coordinator = yield* CoordinatorRuntime;
    const journal = yield* AttemptJournal;
    // Serializes routing decisions with the notices that wait for them.
    const routing = yield* Semaphore.make(1);
    /** The runtime of each `execute` call running in this process. */
    const executing = new Map<AttemptId, AttemptRuntime["Service"]>();
    /** Worker notices for Attempts that no runtime has, kept with `keepNotice`. */
    const waiting = new Map<AttemptId, ReadonlyArray<AttemptChannel.WorkerNotice>>();

    const coordinated = (attemptId: AttemptId) =>
      journal.load(attemptId).pipe(Effect.map(Option.isSome));

    /** The runtime that owns a started Attempt; the Pi runtime if the journal doesn't have it. */
    const owner = (attemptId: AttemptId) =>
      coordinated(attemptId).pipe(
        Effect.map((found) => (found ? coordinator : pi)),
        Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
      );

    /** The runtime that owns an Attempt, or `None` if neither runtime has it. */
    const known = (attemptId: AttemptId) =>
      Effect.gen(function* () {
        const running = executing.get(attemptId);
        if (running !== undefined) return Option.some(running);
        if (yield* coordinated(attemptId)) return Option.some(coordinator);
        const stored = yield* pi.request(attemptId);
        return Option.isSome(stored) ? Option.some(pi) : Option.none();
      });

    const execute = Effect.fn("AttemptRouter.execute")(function* (
      request: AttemptRequest,
      io: AttemptChannel.Sink,
    ) {
      const attemptId = request.spec.attemptId;
      const runtime = yield* routing.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* known(attemptId).pipe(
            Effect.catchTag("JournalError", (error) => Effect.fail(infra(error))),
          );
          const runtime = Option.getOrElse(found, () =>
            request.spec.coordinator === "events" ? coordinator : pi,
          );
          executing.set(attemptId, runtime);
          const kept = waiting.get(attemptId) ?? [];
          waiting.delete(attemptId);
          for (const notice of kept) yield* runtime.notify(attemptId, notice);
          yield* Effect.logInfo("Routed the Attempt to its coordinator", {
            attemptId,
            runtime: runtime === coordinator ? "event-driven" : "pi",
            coordinator: request.spec.coordinator,
            reattached: Option.isSome(found),
            notices: kept.length,
          });
          return runtime;
        }),
      );
      return yield* runtime.execute(request, io).pipe(
        Effect.ensuring(
          routing.withPermits(1)(
            Effect.sync(() => {
              if (executing.get(attemptId) === runtime) executing.delete(attemptId);
            }),
          ),
        ),
      );
    });

    const notify: AttemptRuntime["Service"]["notify"] = (attemptId, notice) =>
      routing
        .withPermits(1)(
          Effect.gen(function* () {
            const found = yield* known(attemptId).pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  "Could not read which coordinator runs the Attempt; the Pi runtime keeps the notice",
                  { attemptId, errorTag: error._tag, message: error.message },
                ),
              ),
              Effect.orElseSucceed(() => Option.some(pi)),
            );
            if (Option.isSome(found)) return Option.some(found.value);
            const kept = keepNotice(waiting.get(attemptId) ?? [], notice);
            waiting.set(attemptId, kept);
            yield* Effect.logInfo("Kept a Worker notice until the Attempt's execute call", {
              attemptId,
              notice: notice._tag,
              kept: kept.map(({ _tag }) => _tag),
            });
            return Option.none<AttemptRuntime["Service"]>();
          }),
        )
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (runtime) => runtime.notify(attemptId, notice),
            }),
          ),
          Effect.withSpan("AttemptRouter.notify"),
        );

    const attached: AttemptRuntime["Service"]["attached"] = (attemptId) =>
      known(attemptId).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not read which coordinator runs the Attempt", {
            attemptId,
            errorTag: error._tag,
            message: error.message,
          }),
        ),
        Effect.orElseSucceed(() => Option.none<AttemptRuntime["Service"]>()),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.raceFirst(pi.attached(attemptId), coordinator.attached(attemptId)),
            onSome: (runtime) => runtime.attached(attemptId),
          }),
        ),
        Effect.withSpan("AttemptRouter.attached"),
      );

    return AttemptRuntime.of({
      execute,
      notify,
      attached,
      isLive: (attemptId) =>
        Effect.flatMap(owner(attemptId), (runtime) => runtime.isLive(attemptId)),
      finished: (attemptId) =>
        Effect.flatMap(owner(attemptId), (runtime) => runtime.finished(attemptId)),
      recordResult: (attemptId, result) =>
        Effect.flatMap(owner(attemptId), (runtime) => runtime.recordResult(attemptId, result)),
      recordUnsupervised: (attemptId, unsupervised) =>
        Effect.flatMap(owner(attemptId), (runtime) =>
          runtime.recordUnsupervised(attemptId, unsupervised),
        ),
      unsupervised: (attemptId) =>
        Effect.flatMap(owner(attemptId), (runtime) => runtime.unsupervised(attemptId)),
      request: (attemptId) =>
        Effect.flatMap(owner(attemptId), (runtime) => runtime.request(attemptId)),
      intervene: (attemptId, intervention) =>
        Effect.flatMap(owner(attemptId), (runtime) => runtime.intervene(attemptId, intervention)),
      cancel: (attemptId) =>
        Effect.flatMap(owner(attemptId), (runtime) => runtime.cancel(attemptId)),
      settle: (attemptId) =>
        Effect.flatMap(owner(attemptId), (runtime) => runtime.settle(attemptId)),
    });
  }),
);

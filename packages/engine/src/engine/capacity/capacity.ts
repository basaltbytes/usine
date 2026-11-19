import { InstanceScope } from "@usine/core/access";
import type { BrainSpec } from "@usine/core/agent/brain";
import { type Attempt, capacityRefusalStreak } from "@usine/core/attempt";
import type * as AttemptChannel from "@usine/core/attempt/channel";
import type { AttemptFailure } from "@usine/core/attempt/failure";
import { ChangeBus, type ScopedChange } from "@usine/core/changes";
import type { LoopName } from "@usine/core/loop";
import type { RunId } from "@usine/core/run";
import type { StepCompletion } from "@usine/core/step/result";
import type { WorkerName } from "@usine/core/worker";
import { Context, DateTime, Deferred, Duration, Effect, Layer, Option, Ref, Result } from "effect";
import * as Capacity from "./state.ts";

export { CapacityGroup, capacityGroupKey, CapacityWait, type CapacityTurn } from "./state.ts";

/** An Attempt that ran under `ProviderCapacity.gate`, and its executor result. */
export interface EndedAttempt {
  readonly attempt: Attempt;
  readonly result: Result.Result<StepCompletion, AttemptFailure>;
}

/** The claim of a Run's new Attempt on its capacity group. */
export interface CapacityClaimRequest<E, R> {
  readonly loop: LoopName;
  readonly worker: WorkerName;
  readonly turn: Capacity.CapacityTurn;
  /** Reads the brain of the Run's Agent; it runs only while a group is at capacity. */
  readonly brain: Effect.Effect<Pick<BrainSpec, "harness" | "model">, E, R>;
}

/** Reports one transcript envelope of a running Attempt to `ProviderCapacity`. */
export type CapacityObserver = (
  attempt: Attempt,
  envelope: AttemptChannel.Envelope,
) => Effect.Effect<void>;

/** Returns whether `envelope` reports the first answer of a child session's model provider. */
const providerAnswered = (envelope: AttemptChannel.Envelope): boolean =>
  envelope._tag === "OutboundEnvelope" &&
  envelope.payload._tag === "SessionEvent" &&
  envelope.payload.event._tag === "ProviderAnswered" &&
  envelope.payload.event.session._tag === "ChildSession";

const groupFields = (group: Capacity.CapacityGroup) => ({
  worker: group.worker,
  harness: group.harness,
  model: group.model,
});

const waitFields = (wait: Capacity.CapacityWait) => ({
  ...groupFields(wait.group),
  message: wait.message,
  refusals: wait.refusals,
  since: DateTime.formatIso(wait.since),
  nextTryAt: DateTime.formatIso(wait.nextTryAt),
  probes: wait.probes,
  waitingRuns: wait.runIds.length,
});

/**
 * Tracks the capacity groups whose provider refuses requests, in this process. A refusal marks
 * the group; Runs that need it wait without an Attempt, one Attempt at a time tests it after the
 * backoff, and the first answer from its provider releases the waiting Runs. After a restart, each
 * Run that waits registers its refusals again. The rules are in `state.ts`.
 */
export class ProviderCapacity extends Context.Service<
  ProviderCapacity,
  {
    /**
     * Registers the consecutive capacity refusals that end `attempts`, the Attempts of the Run
     * `runId` of `loop` from oldest to newest, in the group of the newest refusal, unless the
     * claim of the Run's slot made it wait for another group. Then waits for the Run's turn: until
     * the group it waits for is free, or until no Attempt tests the group and its next try has
     * come. Returns `Forced` when an operator retry ends the wait, and `Due` otherwise.
     */
    readonly awaitTurn: (run: {
      readonly runId: RunId;
      readonly loop: LoopName;
      readonly attempts: ReadonlyArray<Attempt>;
    }) => Effect.Effect<Capacity.CapacityTurn>;
    /**
     * Runs `attempt` of the Run `runId`, unless `claim`, the claim of a new Attempt, finds the
     * Run's group at capacity when it isn't the Run's turn: then the Run waits for the group, and
     * `gate` returns `None`. `attempt` passes each transcript envelope to the observer it receives, and a
     * child's `ProviderAnswered` releases the group. An Attempt that ended settles the group: a
     * success or a failure that the provider answered releases it, and an infrastructure failure
     * or a defect ends the Run's test of it. A capacity refusal is registered when the Run waits.
     */
    readonly gate: <A, E, R, E2 = never, R2 = never>(
      runId: RunId,
      claim: Option.Option<CapacityClaimRequest<E2, R2>>,
      attempt: (observe: CapacityObserver) => Effect.Effect<Result.Result<EndedAttempt, A>, E, R>,
    ) => Effect.Effect<Option.Option<Result.Result<EndedAttempt, A>>, E | E2, R | R2>;
    /**
     * Ends the next or current wait of `runId` for an operator retry. Returns whether a waiting
     * fiber of the Run was woken.
     */
    readonly force: (runId: RunId) => Effect.Effect<boolean>;
    /** Removes `runId` from the waiting Runs, the testing Attempts, and the forced retries. */
    readonly leave: (runId: RunId) => Effect.Effect<void>;
    /** The groups at capacity, ordered by when they started refusing. */
    readonly waits: Effect.Effect<ReadonlyArray<Capacity.CapacityWait>>;
  }
>()("@usine/engine/engine/capacity/capacity/ProviderCapacity") {
  static readonly layer = Layer.effect(
    ProviderCapacity,
    Effect.gen(function* () {
      const bus = yield* ChangeBus;
      const state = yield* Ref.make(Capacity.emptyCapacity);
      const initial = yield* Deferred.make<void>();
      const changed = yield* Ref.make(initial);
      // The waiting fiber of each Run, which an operator retry wakes.
      const wakes = yield* Ref.make<ReadonlyMap<RunId, Deferred.Deferred<void>>>(new Map());

      /** Wakes every waiting Run, and refreshes the attention view and the views of `runs`. */
      const announce = Effect.fn("ProviderCapacity.announce")(function* (
        runs: ReadonlyArray<readonly [RunId, LoopName]>,
      ) {
        const next = yield* Deferred.make<void>();
        const previous = yield* Ref.getAndSet(changed, next);
        yield* Deferred.succeed(previous, undefined);
        const changes: Array<ScopedChange> = [
          { audience: InstanceScope.make(), target: { kind: "attention", id: "instance" } },
          ...runs.map(([runId, loop]): ScopedChange => ({
            audience: { _tag: "Loop", loop },
            target: { kind: "run", id: runId },
          })),
        ];
        yield* bus.publish(changes);
      });

      /** Announces a change of the groups `keys` to the Runs that wait for them. */
      const announceGroups = (keys: ReadonlyArray<string>) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            announce(keys.flatMap((key) => Capacity.waitersOf(current, key))),
          ),
        );

      const refused = Effect.fn("ProviderCapacity.refused")(function* (
        attempt: Attempt,
        loop: LoopName,
      ) {
        const fields = { runId: attempt.runId, attemptId: attempt.id };
        yield* Effect.annotateCurrentSpan(fields);
        const refusal = Capacity.refusalOf(attempt, loop);
        if (Option.isNone(refusal)) {
          yield* Effect.logInfo(
            "The capacity refusal has no end time; the Run waits for no group after it",
            fields,
          );
          return;
        }
        const group = refusal.value.group;
        const key = Capacity.capacityGroupKey(group);
        const recorded = yield* Ref.modify(state, (current) =>
          Capacity.refused(current, refusal.value),
        );
        const groupLog = { ...fields, ...groupFields(group) };
        if (recorded === "Stale") {
          yield* Effect.logInfo(
            "The capacity refusal ended before the provider last answered in its group; the Run doesn't wait for it",
            groupLog,
          );
          return recorded;
        }
        if (recorded === "Known") return recorded;
        const current = yield* Ref.get(state);
        if (recorded === "Elsewhere") {
          yield* Effect.logInfo(
            "The Run keeps waiting for the group that the claim of its slot put it in; its capacity refusal in another group doesn't move it",
            { ...groupLog, waitsFor: current.waiting.get(attempt.runId)?.key },
          );
          return recorded;
        }
        const wait = Option.getOrUndefined(Capacity.waitFor(current, key));
        const logged = wait === undefined ? groupLog : { ...fields, ...waitFields(wait) };
        if (recorded === "Marked")
          yield* Effect.logWarning(
            "The provider refused the Attempt for capacity; Runs that need its group wait, and one Attempt at a time tests it",
            {
              ...logged,
              resetsAt: Option.getOrUndefined(
                Option.map(refusal.value.resetsAt, DateTime.formatIso),
              ),
            },
          );
        else
          yield* Effect.logInfo(
            "The Run waits again for its group after a capacity refusal recorded before",
            logged,
          );
        yield* announceGroups([key]);
        return recorded;
      });

      /** Settles the group of `attempt` after it ended with `end`, and logs what changed. */
      const settle = Effect.fn("ProviderCapacity.settle")(function* (
        attempt: Attempt,
        end: Capacity.AttemptEnd,
      ) {
        const group = Capacity.capacityGroupOf(attempt.brain, attempt.worker);
        const fields = { runId: attempt.runId, attemptId: attempt.id, end, ...groupFields(group) };
        yield* Effect.annotateCurrentSpan(fields);
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(state, (current) =>
          Capacity.settled(current, {
            runId: attempt.runId,
            group,
            startedAt: attempt.startedAt,
            end,
            now,
          }),
        );
        switch (outcome._tag) {
          case "Free":
          case "Refused":
            return;
          case "Earlier":
            return yield* Effect.logInfo(
              "The provider answered an Attempt that started before its group's latest refusal; the group stays at capacity",
              fields,
            );
          case "Released":
            yield* Effect.logInfo(
              "The provider answered in a group at capacity; the Runs waiting for it start",
              { ...fields, releasedRunIds: outcome.runs.map(([runId]) => runId) },
            );
            return yield* announce(outcome.runs);
          case "Left":
            if (outcome.groups.length === 0) return;
            yield* Effect.logInfo(
              "The Attempt that tested a group at capacity ended without showing whether the provider answered; another waiting Run tests the group",
              { ...fields, groups: outcome.groups },
            );
            return yield* announceGroups(outcome.groups);
        }
      });

      /** Settles the group of `attempt` while it is at capacity; a free group needs nothing. */
      const settleAtCapacity = (attempt: Attempt, end: Capacity.AttemptEnd) =>
        Ref.get(state).pipe(
          Effect.flatMap((current) =>
            current.groups.size > 0 ? settle(attempt, end) : Effect.void,
          ),
        );

      const observe: CapacityObserver = (attempt, envelope) =>
        providerAnswered(envelope) ? settleAtCapacity(attempt, "Succeeded") : Effect.void;

      const leave = Effect.fn("ProviderCapacity.leave")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        const keys = yield* Ref.modify(state, (current) => Capacity.leave(current, runId));
        if (keys.length === 0) return;
        yield* Effect.logInfo(
          "The Run no longer waits for or tests a group at capacity; a group that no Run needs is dropped",
          { runId, groups: keys },
        );
        yield* announceGroups(keys);
      });

      const claim = Effect.fn("ProviderCapacity.claim")(function* <E, R>(
        runId: RunId,
        request: CapacityClaimRequest<E, R>,
      ) {
        const { loop, worker } = request;
        yield* Effect.annotateCurrentSpan({ runId, worker });
        if ((yield* Ref.get(state)).groups.size === 0) {
          // Nothing is at capacity, so the Run's group is free and needs no read of its brain.
          yield* Ref.update(state, (current) => Capacity.leave(current, runId)[1]);
          return "Free" as const;
        }
        const brain = yield* request.brain;
        const group = Capacity.capacityGroupOf(brain, worker);
        const now = yield* DateTime.now;
        const claimed = yield* Ref.modify(state, (current) =>
          Capacity.claim(current, { runId, loop, group, turn: request.turn, now }),
        );
        const fields = { runId, ...groupFields(group) };
        const current = yield* Ref.get(state);
        const others = claimed.left.flatMap((other) => Capacity.waitersOf(current, other));
        if (claimed.left.length > 0)
          yield* Effect.logInfo(
            "The Run elected to test a group at capacity got a slot for another group; the Runs waiting for the first group elect another",
            { ...fields, left: claimed.left },
          );
        const wait = Capacity.waitFor(current, Capacity.capacityGroupKey(group));
        if (claimed.claim === "Free" || Option.isNone(wait)) {
          if (others.length > 0) yield* announce(others);
          return claimed.claim;
        }
        const logged = { ...fields, ...waitFields(wait.value) };
        if (claimed.claim === "Wait")
          yield* Effect.logInfo(
            "The Run's group is at capacity; it frees its Worker slot and waits without an Attempt",
            logged,
          );
        else
          yield* Effect.logInfo(
            claimed.forced
              ? "An operator retry tests the group at capacity"
              : "The Run's Attempt tests the group at capacity; the other Runs that need it keep waiting",
            logged,
          );
        yield* announce([
          ...Capacity.waitersOf(current, Capacity.capacityGroupKey(group)),
          ...others,
        ]);
        return claimed.claim;
      });

      const gate = Effect.fn("ProviderCapacity.gate")(function* <A, E, R, E2, R2>(
        runId: RunId,
        request: Option.Option<CapacityClaimRequest<E2, R2>>,
        attempt: (observe: CapacityObserver) => Effect.Effect<Result.Result<EndedAttempt, A>, E, R>,
      ) {
        yield* Effect.annotateCurrentSpan({ runId });
        if (Option.isSome(request) && (yield* claim(runId, request.value)) === "Wait")
          return Option.none<Result.Result<EndedAttempt, A>>();
        const ran = yield* attempt(observe);
        if (Result.isSuccess(ran)) {
          const { attempt: ended, result } = ran.success;
          yield* Effect.annotateCurrentSpan({ attemptId: ended.id });
          yield* settleAtCapacity(
            ended,
            Result.match(result, {
              onSuccess: () => "Succeeded" as const,
              onFailure: ({ _tag }) => _tag,
            }),
          );
        }
        return Option.some(ran);
      });

      /** Waits until the Run's turn comes, and returns how its wait ended. */
      const waitTurn = Effect.fn("ProviderCapacity.waitTurn")(function* (runId: RunId) {
        const wake = yield* Deferred.make<void>();
        yield* Ref.update(wakes, (current) => new Map(current).set(runId, wake));
        // Whether the Run's wait was logged, so a long wait logs once.
        let logged = false;
        return yield* Effect.gen(function* () {
          while (true) {
            const signal = yield* Ref.get(changed);
            const now = yield* DateTime.now;
            const step = yield* Ref.modify(state, (current) => Capacity.turn(current, runId, now));
            switch (step._tag) {
              case "Forced":
                yield* Effect.logInfo("An operator retry ends the Run's wait for its group", {
                  runId,
                });
                return "Forced" as const;
              case "Free":
              case "Due":
                if (step._tag === "Due" && step.elected)
                  yield* Effect.logInfo("The Run's next Attempt tests its group at capacity", {
                    runId,
                    ...groupFields(step.group),
                  });
                return "Due" as const;
              case "Sleep": {
                const delayMillis =
                  DateTime.toEpochMillis(step.until) - DateTime.toEpochMillis(now);
                if (!logged)
                  yield* Effect.logInfo("The Run waits for its group at capacity", {
                    runId,
                    ...groupFields(step.group),
                    nextTryAt: DateTime.formatIso(step.until),
                    delayMillis,
                  });
                logged = true;
                yield* Effect.raceFirst(
                  Deferred.await(wake),
                  Effect.raceFirst(
                    Deferred.await(signal),
                    Effect.sleep(Duration.millis(delayMillis)),
                  ),
                );
                break;
              }
              case "AwaitProbe":
                if (!logged)
                  yield* Effect.logInfo(
                    "The Run waits while another Attempt tests its group at capacity",
                    { runId, ...groupFields(step.group) },
                  );
                logged = true;
                yield* Effect.raceFirst(Deferred.await(wake), Deferred.await(signal));
                break;
            }
          }
        }).pipe(
          Effect.ensuring(
            Ref.update(wakes, (current) => {
              if (current.get(runId) !== wake) return current;
              const next = new Map(current);
              next.delete(runId);
              return next;
            }),
          ),
        );
      });

      const awaitTurn = Effect.fn("ProviderCapacity.awaitTurn")(function* (run: {
        readonly runId: RunId;
        readonly loop: LoopName;
        readonly attempts: ReadonlyArray<Attempt>;
      }) {
        yield* Effect.annotateCurrentSpan({ runId: run.runId });
        // The streak is in one group, so a Run that waits for another group skips all of it.
        for (const attempt of capacityRefusalStreak(run.attempts))
          if ((yield* refused(attempt, run.loop)) === "Elsewhere") break;
        return yield* waitTurn(run.runId);
      });

      const force = Effect.fn("ProviderCapacity.force")(function* (runId: RunId) {
        yield* Effect.annotateCurrentSpan({ runId });
        yield* Ref.update(state, (current) => Capacity.force(current, runId));
        const wake = (yield* Ref.get(wakes)).get(runId);
        if (wake !== undefined && (yield* Deferred.succeed(wake, undefined))) return true;
        yield* Effect.logInfo(
          "An operator retry applies at the Run's next claim of its group, as the Run doesn't wait now",
          { runId },
        );
        return false;
      });

      const waits = Ref.get(state).pipe(
        Effect.map(Capacity.waitsOf),
        Effect.withSpan("ProviderCapacity.waits"),
      );

      return { awaitTurn, gate, force, leave, waits };
    }),
  );
}

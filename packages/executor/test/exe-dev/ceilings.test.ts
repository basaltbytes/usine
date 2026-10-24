import { assert, describe, it } from "@effect/vitest";
import { SessionTokensUpdated, TokenCount } from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { type AttemptFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptRuntime } from "@usine/durable/attempt-runtime";
import {
  type StubParent,
  type StubParentContext,
  StubStorage,
  completes,
} from "@usine/durable/testing";
import { Deferred, type Duration, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { CheckoutRequest, Executor } from "../../src/executor.ts";
import { ATTEMPT_ID, TEST_AGENT, WORKER, fakeSsh, recording, request, runtime } from "./support.ts";

/**
 * Runs `checkout` in one orchestrator process whose parent runs `first` and then sends
 * nothing, and stops the process `after` the parent starts.
 */
const stopAfter = (
  ssh: ReturnType<typeof fakeSsh>,
  storage: StubStorage,
  checkout: CheckoutRequest,
  sink: AttemptChannel.Sink,
  after: Duration.Input,
  first: (context: StubParentContext) => Effect.Effect<void, AttemptFailure> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const quiet: StubParent = (context) =>
      first(context).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
      );
    yield* Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      const prepared = yield* executor.prepare(checkout);
      const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(after);
      yield* Fiber.interrupt(launch);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, quiet, storage)));
  });

describe("exe.dev ceilings across a restart", () => {
  it.effect(
    "resumes a reattached Attempt's wall clock from the time it ran before each restart and stops its parent task when it trips",
    () => {
      const ssh = fakeSsh();
      const storage = new StubStorage();
      const minute = new CheckoutRequest({ ...request, maxAttemptMinutes: Option.some(1) });
      const reattach = new CheckoutRequest({ ...minute, reattach: true });
      const { transcript, sink } = recording();
      return Effect.gen(function* () {
        // The parent is silent for 30 of its 60 seconds, then the process stops.
        yield* stopAfter(ssh, storage, minute, sink, "30 seconds");
        yield* TestClock.adjust("10 minutes");
        // After reattachment, the parent runs 12 more seconds, then the process stops again.
        yield* stopAfter(ssh, storage, reattach, sink, "12 seconds");
        yield* TestClock.adjust("10 minutes");
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
          const prepared = yield* executor.prepare(reattach);
          const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
          // Advances one second at a time so the guard sets its next timer after the warning.
          for (let second = 0; second < 17; second += 1) yield* TestClock.adjust("1 second");
          assert.strictEqual(launch.pollUnsafe(), undefined);
          yield* TestClock.adjust("1 second");
          const failure = yield* Fiber.join(launch).pipe(Effect.flip);
          assert(failure._tag === "RunawayFailure");
          assert.strictEqual(failure.ceiling, "wall-clock");
          assert.strictEqual(storage.tasks.get(ATTEMPT_ID)?.state._tag, "canceled");
        }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, () => Effect.never, storage)));
        assert.deepStrictEqual(
          transcript.flatMap(([, envelope]) =>
            envelope._tag === "InboundEnvelope" && envelope.payload._tag === "Steer"
              ? [envelope.payload.message]
              : [],
          ),
          ["0.8 of 1 minutes used by this Attempt; commit and push your work now."],
        );
      });
    },
  );

  /** Ceilings lowered before a restart to below what the Attempt already used. */
  const lowered = [
    {
      ceiling: "wall-clock",
      before: { maxAttemptMinutes: Option.some(2) },
      after: { maxAttemptMinutes: Option.some(1) },
      first: () => Effect.void,
    },
    {
      // After reattachment the parent reports no more usage; the relay sends a total only when it grows.
      ceiling: "tokens",
      before: { maxAttemptTokens: Option.some(200) },
      after: { maxAttemptTokens: Option.some(100) },
      first: ({ emit, session }: StubParentContext) =>
        emit(
          new AttemptChannel.SessionEvent({
            event: new SessionTokensUpdated({ session, totalTokens: TokenCount.make(120) }),
          }),
        ),
    },
  ] as const;

  for (const { ceiling, before, after, first } of lowered) {
    it.effect(
      `trips a reattached Attempt whose earlier run spent its lowered ${ceiling} ceiling and stops its parent task`,
      () => {
        const ssh = fakeSsh();
        const storage = new StubStorage();
        const { sink } = recording();
        return Effect.gen(function* () {
          const earlier = new CheckoutRequest({ ...request, ...before });
          yield* stopAfter(ssh, storage, earlier, sink, "70 seconds", first);
          yield* Effect.gen(function* () {
            const executor = yield* Executor;
            yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
            const prepared = yield* executor.prepare(
              new CheckoutRequest({ ...request, ...after, reattach: true }),
            );
            const failure = yield* prepared.launch(sink).pipe(Effect.flip);
            assert(failure._tag === "RunawayFailure");
            assert.strictEqual(failure.ceiling, ceiling);
            assert.strictEqual(storage.tasks.get(ATTEMPT_ID)?.state._tag, "canceled");
          }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, () => Effect.never, storage)));
        });
      },
    );
  }

  /**
   * Returns a stub runtime whose `execute` completes `executing` when called and relays the
   * channel only after `attach` completes, like the durable runtime after reading storage.
   */
  const attachingOn =
    (executing: Deferred.Deferred<void>, attach: Deferred.Deferred<void>) =>
    (stub: Layer.Layer<AttemptRuntime>) =>
      Layer.effect(
        AttemptRuntime,
        Effect.map(AttemptRuntime, (runtime) =>
          AttemptRuntime.of({
            ...runtime,
            execute: (request, io) =>
              Deferred.succeed(executing, undefined).pipe(
                Effect.andThen(Deferred.await(attach)),
                Effect.andThen(runtime.execute(request, io)),
              ),
          }),
        ),
      ).pipe(Layer.provide(stub));

  /** Ceilings lowered before a restart to past the warning point, with the warning the reattachment must send. */
  const restoredWarnings = [
    {
      ceiling: "tokens",
      before: { maxAttemptTokens: Option.some(200) },
      after: { maxAttemptTokens: Option.some(140) },
      first: ({ emit, session }: StubParentContext) =>
        emit(
          new AttemptChannel.SessionEvent({
            event: new SessionTokensUpdated({ session, totalTokens: TokenCount.make(120) }),
          }),
        ),
      warning: "120 of 140 tokens used by this Attempt; commit and push your work now.",
    },
    {
      ceiling: "wall-clock",
      before: { maxAttemptMinutes: Option.some(2) },
      after: { maxAttemptMinutes: Option.some(1) },
      first: () => Effect.void,
      warning: "0.8 of 1 minutes used by this Attempt; commit and push your work now.",
    },
  ] as const;

  for (const { ceiling, before, after, first, warning } of restoredWarnings) {
    it.effect(
      `delivers the ${ceiling} warning a reattachment owes once its parent's channel is relayed`,
      () => {
        const ssh = fakeSsh();
        const storage = new StubStorage();
        const { transcript, sink } = recording();
        const steers = () =>
          transcript.flatMap(([, envelope]) =>
            envelope._tag === "InboundEnvelope" && envelope.payload._tag === "Steer"
              ? [envelope.payload.message]
              : [],
          );
        return Effect.gen(function* () {
          const earlier = new CheckoutRequest({ ...request, ...before });
          yield* stopAfter(ssh, storage, earlier, sink, "50 seconds", first);
          assert.deepStrictEqual(steers(), [], "the earlier run passed no warning point");
          const executing = yield* Deferred.make<void>();
          const attach = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            const executor = yield* Executor;
            yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
            const prepared = yield* executor.prepare(
              new CheckoutRequest({ ...request, ...after, reattach: true }),
            );
            const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
            // The launch registers the Attempt and starts its guard before `execute` finishes reading
            // durable storage.
            yield* Deferred.await(executing);
            yield* TestClock.adjust("1 second");
            assert.deepStrictEqual(steers(), []);
            yield* Deferred.succeed(attach, undefined);
            for (let tick = 0; tick < 10 && steers().length === 0; tick += 1)
              yield* TestClock.adjust("10 millis");
            assert.deepStrictEqual(steers(), [warning]);
            assert.strictEqual(launch.pollUnsafe(), undefined);
            yield* Fiber.interrupt(launch);
          }).pipe(
            Effect.scoped,
            Effect.provide(
              runtime(ssh.layer, () => Effect.never, storage, attachingOn(executing, attach)),
            ),
          );
        });
      },
    );
  }

  /** Returns a stub runtime that fails to read the recorded unsupervised time. */
  const unreadableTime = (stub: Layer.Layer<AttemptRuntime>) =>
    Layer.effect(
      AttemptRuntime,
      Effect.map(AttemptRuntime, (runtime) =>
        AttemptRuntime.of({
          ...runtime,
          unsupervised: () =>
            new InfraFailure({ message: "Read failed", cause: "storage unavailable" }),
        }),
      ),
    ).pipe(Layer.provide(stub));

  /** The data a reattachment fails to read, with the ceiling of the earlier run that recorded it. */
  const unreadable = [
    {
      part: "transcript",
      ceilings: { maxAttemptTokens: Option.some(100) },
      // A finished child's 80 tokens and the resulting warning are only in the transcript.
      first: ({ emit, session }: StubParentContext) =>
        emit(
          new AttemptChannel.SessionEvent({
            event: new SessionTokensUpdated({ session, totalTokens: TokenCount.make(80) }),
          }),
        ),
      transcriptFails: true,
      wrap: (stub: Layer.Layer<AttemptRuntime>) => stub,
    },
    {
      part: "unsupervised time",
      ceilings: { maxAttemptMinutes: Option.some(1) },
      first: () => Effect.void,
      transcriptFails: false,
      wrap: unreadableTime,
    },
  ] as const;

  for (const { part, ceilings, first, transcriptFails, wrap } of unreadable) {
    it.effect(
      `fails a reattachment whose ${part} cannot be read, after stopping its parent task, and records its salvage`,
      () => {
        const ssh = fakeSsh();
        ssh.state.salvage = "dirty";
        const storage = new StubStorage();
        const { transcript, sink } = recording();
        const checkout = new CheckoutRequest({ ...request, ...ceilings });
        return Effect.gen(function* () {
          yield* stopAfter(ssh, storage, checkout, sink, "40 seconds", first);
          const steers = () =>
            transcript.filter(
              ([, envelope]) =>
                envelope._tag === "InboundEnvelope" && envelope.payload._tag === "Steer",
            ).length;
          const warned = steers();
          // Records the parent task's state at each salvage; no live task may write to the checkout.
          const salvaged: Array<string> = [];
          yield* Effect.gen(function* () {
            const executor = yield* Executor;
            yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
            const prepared = yield* executor.prepare(
              new CheckoutRequest({ ...checkout, reattach: true }),
            );
            const failure = yield* prepared
              .launch({
                ...sink,
                transcript: transcriptFails
                  ? new InfraFailure({ message: "Read failed", cause: "storage unavailable" })
                  : sink.transcript,
                salvage: (salvage) =>
                  Effect.sync(() => {
                    salvaged.push(`${salvage._tag} ${storage.tasks.get(ATTEMPT_ID)?.state._tag}`);
                  }),
              })
              .pipe(Effect.flip);
            assert(failure._tag === "InfraFailure");
            assert.strictEqual(
              failure.message,
              `Can't read the ${part} of the reattached attempt, which the runaway guard needs to resume`,
            );
          }).pipe(
            Effect.scoped,
            Effect.provide(runtime(ssh.layer, () => Effect.never, storage, wrap)),
          );
          assert.strictEqual(storage.tasks.get(ATTEMPT_ID)?.state._tag, "canceled");
          assert.deepStrictEqual(salvaged, ["Pushed canceled"]);
          assert.strictEqual(steers(), warned, "no warning is sent again");
        });
      },
    );
  }

  it.effect("reattaches an Attempt without reading the unsupervised time no ceiling uses", () => {
    const ssh = fakeSsh();
    const storage = new StubStorage();
    const { sink } = recording();
    const tokens = new CheckoutRequest({
      ...request,
      maxAttemptMinutes: Option.none(),
      maxAttemptTokens: Option.some(100),
    });
    return Effect.gen(function* () {
      yield* stopAfter(ssh, storage, tokens, sink, "40 seconds");
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const prepared = yield* executor.prepare(
          new CheckoutRequest({ ...tokens, reattach: true }),
        );
        const result = yield* prepared.launch(sink);
        assert.strictEqual(result.message, `Completed: ${request.task}`);
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(ssh.layer, completes, storage, unreadableTime)),
      );
    });
  });
});

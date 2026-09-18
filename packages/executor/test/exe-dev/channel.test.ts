import { InfraFailure } from "@usine/core/attempt/failure";
import { assert, describe, it } from "@effect/vitest";

import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { BrainSpec } from "@usine/core/agent/brain";

import * as AttemptChannel from "@usine/core/attempt/channel";

import { CheckoutRequest, Executor } from "../../src/executor.ts";

import { Deferred, Effect, Exit, Fiber, Result, Scope, Option } from "effect";

import { TestClock } from "effect/testing";

import {
  ATTEMPT_ID,
  WORKER,
  PROTOCOL,
  TEST_AGENT,
  remoteArgs,
  fakeSsh,
  request,
  runtime,
} from "./support.ts";

describe("exe.dev channel", () => {
  it.effect("keeps input sequences contiguous when persistence rejects an intervention", () => {
    const ssh = fakeSsh(PROTOCOL, "wait-for-interrupt");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      const prepared = yield* executor.prepare(request);
      const started = yield* Deferred.make<void>();
      let reject = true;
      const launch = yield* prepared
        .launch({
          salvage: () => Effect.void,
          append: (direction, envelope) => {
            if (envelope.payload._tag === "Started")
              return Effect.asVoid(Deferred.succeed(started, undefined));
            if (direction === "inbound" && reject) {
              reject = false;
              return new InfraFailure({
                message: "Store temporarily unavailable",
                cause: new Error("unavailable"),
              });
            }
            return Effect.void;
          },
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      const intervention = new AttemptChannel.Intervention({
        operator: "Philippe",
        target: new AttemptChannel.ParentTarget(),
        action: new AttemptChannel.Steer({ message: "Continue" }),
      });
      const failure = yield* Effect.flip(executor.intervene(ATTEMPT_ID, intervention));
      assert.strictEqual(failure._tag, "InfraFailure");
      yield* executor.intervene(ATTEMPT_ID, intervention);
      yield* executor.cancel(ATTEMPT_ID);
      yield* Fiber.join(launch);
      const inputs = ssh.state.inputs.filter((input) => input._tag === "InboundEnvelope");
      assert.deepStrictEqual(
        inputs.map(({ sequence, payload }) => [sequence, payload._tag]),
        [
          [1, "Steer"],
          [2, "Cancel"],
        ],
      );
      assert.strictEqual(inputs[0]?.operator, "Philippe");
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("finishes persisted delivery after its caller disconnects", () => {
    const ssh = fakeSsh(PROTOCOL, "wait-for-interrupt");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      const prepared = yield* executor.prepare(request);
      const started = yield* Deferred.make<void>();
      const persisted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let first = true;
      const launch = yield* prepared
        .launch({
          salvage: () => Effect.void,
          append: (_direction, envelope) => {
            if (envelope.payload._tag === "Started")
              return Effect.asVoid(Deferred.succeed(started, undefined));
            if (envelope.payload._tag === "Steer" && first) {
              first = false;
              return Deferred.succeed(persisted, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              );
            }
            return Effect.void;
          },
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      const intervention = new AttemptChannel.Intervention({
        operator: "Philippe",
        target: new AttemptChannel.ParentTarget(),
        action: new AttemptChannel.Steer({ message: "Continue" }),
      });
      const caller = yield* executor.intervene(ATTEMPT_ID, intervention).pipe(Effect.forkChild);
      yield* Deferred.await(persisted);
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(release, undefined);
      yield* executor.intervene(ATTEMPT_ID, intervention);
      yield* executor.cancel(ATTEMPT_ID);
      yield* Fiber.join(launch);
      assert.deepStrictEqual(
        ssh.state.inputs
          .filter((input) => input._tag === "InboundEnvelope")
          .map(({ sequence, payload }) => [sequence, payload._tag]),
        [
          [1, "Steer"],
          [2, "Steer"],
          [3, "Cancel"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("shuts down through Cancel before returning a reported token ceiling", () => {
    const ssh = fakeSsh(PROTOCOL, "token-limit");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      const prepared = yield* executor.prepare(request);
      const outcome = yield* prepared
        .launch({ append: () => Effect.void, salvage: () => Effect.void })
        .pipe(Effect.result);
      assert(Result.isFailure(outcome) && outcome.failure._tag === "RunawayFailure");
      assert.strictEqual(outcome.failure.ceiling, "tokens");
      assert.strictEqual(
        ssh.state.inputs.filter((input) => input._tag === "InboundEnvelope").at(-1)?.payload._tag,
        "Cancel",
      );
      assert.strictEqual(ssh.state.kills, 0);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect(
    "closing the prepared scope stops its active channel before remote resource cleanup",
    () => {
      const ssh = fakeSsh(PROTOCOL, "wait-for-interrupt");
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
        const owner = yield* Scope.make();
        const prepared = yield* executor.prepare(request).pipe(Scope.provide(owner));
        const started = yield* Deferred.make<void>();
        const launched = yield* prepared
          .launch({
            salvage: () => Effect.void,
            append: (_direction, envelope) =>
              envelope.payload._tag === "Started"
                ? Effect.asVoid(Deferred.succeed(started, undefined))
                : Effect.void,
          })
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(started);
        const beforeCleanup = ssh.state.commands.length;
        yield* Scope.close(owner, Exit.void);
        assert(Exit.isFailure(yield* Fiber.join(launched)));
        assert.strictEqual(ssh.state.kills, 0);
        assert(
          ssh.state.inputs.some(
            (input) => input._tag === "InboundEnvelope" && input.payload._tag === "Cancel",
          ),
        );
        const cleanup = ssh.state.commands.slice(beforeCleanup).map(({ args }) => args.join(" "));
        const kill = cleanup.findIndex((line) => line.includes("remote-run_execute_1.pid"));
        const remove = cleanup.findIndex((line) => line.includes("'worktree' 'remove'"));
        const detach = cleanup.findIndex((line) => line.includes("integrations detach"));
        assert(kill >= 0 && remove > kill && detach > remove);
        const issued = ssh.state.commands.length;
        yield* Scope.close(owner, Exit.void);
        const reuse = yield* prepared
          .launch({ append: () => Effect.void, salvage: () => Effect.void })
          .pipe(Effect.flip);
        assert.strictEqual(reuse._tag, "InfraFailure");
        assert.strictEqual(ssh.state.commands.length, issued);
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect("checks the roster on the VM and refuses login loss before preparation", () => {
    const ssh = fakeSsh(PROTOCOL);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain, new BrainSpec({ ...TEST_AGENT.brain })]);
      assert.strictEqual(
        ssh.state.commands.filter((command) => remoteArgs(command)[0]?.includes("'--preflight'"))
          .length,
        1,
      );
      ssh.state.readiness = new HarnessUnavailableError({
        harness: "claude",
        capability: "login",
        message: "Claude login expired",
      });
      const error = yield* executor.prepare(request).pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
      assert.strictEqual(error.message, "Claude login expired");
      assert(!ssh.state.commands.some((command) => command.args.includes("attach")));
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("surfaces run-host skew as a typed preflight capability error", () => {
    const ssh = fakeSsh("1");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor.preflight(WORKER, [TEST_AGENT.brain]).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkerCapabilityError");
      if (error._tag !== "WorkerCapabilityError") return;
      assert.strictEqual(error.capability, "run-host");
      assert(error.message.includes(`expected ${PROTOCOL}`));
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("requires a successful SSH exit after the final envelope", () => {
    const ssh = fakeSsh(PROTOCOL, "final-nonzero");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      const prepared = yield* executor.prepare(request);
      const error = yield* prepared
        .launch({ append: () => Effect.void, salvage: () => Effect.void })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "InfraFailure");
      assert(error.message.includes("exited with code 17"));
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("cancels once through the SSH channel and confirms the remote interrupt", () => {
    const ssh = fakeSsh(PROTOCOL, "wait-for-interrupt");
    const transcript: Array<[AttemptChannel.Direction, AttemptChannel.Envelope]> = [];
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      const prepared = yield* executor.prepare(request);
      const launchFiber = yield* prepared
        .launch({
          salvage: () => Effect.void,
          append: (direction, envelope) =>
            Effect.sync(() => {
              transcript.push([direction, envelope]);
            }),
        })
        .pipe(Effect.result, Effect.forkChild);
      while (!transcript.some(([, envelope]) => envelope.payload._tag === "Started")) {
        yield* Effect.yieldNow;
      }

      yield* executor.cancel(ATTEMPT_ID);
      yield* executor.cancel(ATTEMPT_ID);
      const outcome = yield* Fiber.join(launchFiber);
      assert(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "AgentFailure");
      assert.deepStrictEqual(
        ssh.state.inputs.map((input) => input._tag),
        ["Start", "InboundEnvelope"],
      );
      assert.deepStrictEqual(
        transcript.map(([direction, envelope]) => [direction, envelope.payload._tag]),
        [
          ["outbound", "Started"],
          ["inbound", "Cancel"],
          ["outbound", "Interrupted"],
        ],
      );
      assert.strictEqual(ssh.state.kills, 0);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect(
    "bounds live execution and releases resources after the timeout cancellation handshake",
    () => {
      const ssh = fakeSsh(PROTOCOL, "ignore-interrupt");
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
        const prepared = yield* executor.prepare(
          new CheckoutRequest({ ...request, maxAttemptMinutes: Option.some(1) }),
        );
        const started = yield* Deferred.make<void>();
        const stopping = yield* Deferred.make<void>();
        const running = yield* prepared
          .launch({
            salvage: () => Effect.void,
            append: (_direction, envelope) => {
              if (envelope.payload._tag === "Started")
                return Effect.asVoid(Deferred.succeed(started, undefined));
              if (envelope.payload._tag === "Cancel")
                return Effect.asVoid(Deferred.succeed(stopping, undefined));
              return Effect.void;
            },
          })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(stopping);
        yield* TestClock.adjust("2 seconds");
        const outcome = yield* Fiber.join(running);
        assert(Result.isFailure(outcome));
        assert(outcome.failure._tag === "RunawayFailure");
        assert.strictEqual(outcome.failure.ceiling, "wall-clock");
        assert.strictEqual(ssh.state.kills, 1);
        assert.strictEqual(
          ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
          1,
        );
        yield* executor.cancel(ATTEMPT_ID);
        assert.strictEqual(ssh.state.kills, 1);
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect("kills a stalled SSH session after the interrupt grace", () => {
    const ssh = fakeSsh(PROTOCOL, "ignore-interrupt");
    const transcript: Array<[AttemptChannel.Direction, AttemptChannel.Envelope]> = [];
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      const prepared = yield* executor.prepare(request);
      const launchFiber = yield* prepared
        .launch({
          salvage: () => Effect.void,
          append: (direction, envelope) =>
            Effect.sync(() => {
              transcript.push([direction, envelope]);
            }),
        })
        .pipe(Effect.result, Effect.forkChild);
      while (!transcript.some(([, envelope]) => envelope.payload._tag === "Started")) {
        yield* Effect.yieldNow;
      }

      const cancelFiber = yield* executor.cancel(ATTEMPT_ID).pipe(Effect.forkChild);
      while (!transcript.some(([, envelope]) => envelope.payload._tag === "Cancel")) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(cancelFiber);
      yield* executor.cancel(ATTEMPT_ID);
      const outcome = yield* Fiber.join(launchFiber);
      assert(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "InfraFailure");
      assert.strictEqual(ssh.state.kills, 1);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("hard-kills when the persisted interrupt write is parked", () => {
    const ssh = fakeSsh(PROTOCOL, "ignore-interrupt");
    const transcript: Array<[AttemptChannel.Direction, AttemptChannel.Envelope]> = [];
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      const prepared = yield* executor.prepare(request);
      const launchFiber = yield* prepared
        .launch({
          salvage: () => Effect.void,
          append: (direction, envelope) =>
            direction === "inbound"
              ? Effect.never
              : Effect.sync(() => {
                  transcript.push([direction, envelope]);
                }),
        })
        .pipe(Effect.result, Effect.forkChild);
      while (!transcript.some(([, envelope]) => envelope.payload._tag === "Started")) {
        yield* Effect.yieldNow;
      }

      const cancelFiber = yield* executor.cancel(ATTEMPT_ID).pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      const canceled = yield* Fiber.join(cancelFiber);
      assert(Result.isFailure(canceled));
      if (Result.isFailure(canceled)) {
        assert.strictEqual(canceled.failure._tag, "ExecutorOperationError");
      }
      assert.strictEqual(ssh.state.kills, 1);
      yield* executor.cancel(ATTEMPT_ID);
      const outcome = yield* Fiber.join(launchFiber);
      assert(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "InfraFailure");
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });
});

import { assert, describe, it } from "@effect/vitest";

import { AttemptId } from "@usine/core/attempt";

import { type AttemptSalvage, SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { InfraFailure } from "@usine/core/attempt/failure";
import { LoopName } from "@usine/core/loop";
import { WorkerName } from "@usine/core/worker";
import { CheckoutRequest, Executor } from "../../src/executor.ts";

import { TestClock } from "effect/testing";
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Option, Scope } from "effect";

import {
  ATTEMPT_ID,
  WORKER,
  SALVAGE_COMMIT,
  TEST_AGENT,
  fails,
  fakeSsh,
  remoteLine,
  request,
  runtime,
} from "./support.ts";

describe("exe.dev preparation", () => {
  it.effect.each(["dirty", "push-fails"] as const)(
    "salvages an unsuccessful Attempt's worktree before cleanup (%s)",
    (salvage) => {
      const ssh = fakeSsh();
      ssh.state.salvage = salvage;
      const recorded: Array<AttemptSalvage> = [];
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const prepared = yield* executor.prepare(request);
        const failure = yield* prepared
          .launch({
            append: () => Effect.void,
            comments: () => Effect.void,
            salvage: (value) =>
              Effect.sync(() => {
                assert(
                  !ssh.state.commands.some((command) =>
                    remoteLine(command).includes("'worktree' 'remove'"),
                  ),
                  "salvage must be recorded before checkout removal",
                );
                recorded.push(value);
              }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InfraFailure");
        const lines = ssh.state.commands.map(remoteLine);
        const push = lines.findIndex((line) => line.includes("'push' '--force'"));
        assert(push >= 0, "the salvage push never ran");
        // Preparation removes any stale directory first; only a removal after
        // the push is cleanup.
        const removal = lines.findIndex(
          (line, index) =>
            index > push &&
            line.startsWith("exec 'rm' '-rf'") &&
            line.includes("/attempts/remote-run_execute_1'"),
        );
        assert(lines[push]?.includes(`'${SALVAGE_COMMIT}:refs/heads/${request.salvageRef}'`));
        assert(
          lines.some((line) => line.includes("'wip(usine): salvage attempt remote-run/execute/1'")),
        );
        if (salvage === "dirty") {
          assert(removal > push, "the worktree was removed before the salvage push");
          assert.deepStrictEqual(recorded, [
            new SalvagePushed({ ref: request.salvageRef, commit: SALVAGE_COMMIT }),
          ]);
        } else {
          assert.strictEqual(removal, -1, "a worktree whose push failed must stay on disk");
          assert.strictEqual(recorded.length, 1);
          assert(recorded[0]?._tag === "Retained");
          assert(recorded[0].path.endsWith("/attempts/remote-run_execute_1"));
          assert.deepStrictEqual(recorded[0].commit, Option.some(SALVAGE_COMMIT));
        }
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, fails)));
    },
  );

  it.effect(
    "refuses a read Loop's Attempt before attaching the integration, which cannot grant read-only access",
    () => {
      const ssh = fakeSsh();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const failure = yield* executor
          .prepare(
            new CheckoutRequest({
              ...request,
              loop: LoopName.make("review-pr"),
              permissions: "read",
            }),
          )
          .pipe(Effect.flip);
        assert(failure._tag === "WorkerCapabilityError");
        assert.strictEqual(failure.worker, WORKER);
        assert.strictEqual(failure.capability, "credentials");
        assert.include(failure.message, "remote-one");
        assert.include(failure.message, "review-pr");
        assert.include(failure.message, "read-only");
        const commandLine = ssh.state.commands.map(({ args }) => args.join(" ")).join("\n");
        assert.notInclude(commandLine, "integrations attach");
        assert.notInclude(commandLine, "'clone'");
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect("retains pushed work when durable salvage recording fails", () => {
    const ssh = fakeSsh();
    ssh.state.salvage = "dirty";
    const recordFailure = new InfraFailure({ message: "database unavailable", cause: "outage" });
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      const cleanupStart = ssh.state.commands.length;
      const exit = yield* Effect.exit(
        prepared.launch({
          append: () => Effect.void,
          comments: () => Effect.void,
          salvage: () => Effect.fail(recordFailure),
        }),
      );
      assert(Exit.isFailure(exit));
      assert(Cause.pretty(exit.cause).includes("database unavailable"));
      const lines = ssh.state.commands.slice(cleanupStart).map(remoteLine);
      assert(lines.some((line) => line.includes("'push' '--force'")));
      assert(
        !lines.some(
          (line) => line.includes("'worktree' 'remove'") || line.startsWith("exec 'rm' '-rf'"),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, fails)));
  });

  it.effect.each(["lookup", "fetch", "decode"] as const)(
    "rejects retry preparation when salvage %s fails",
    (failure) => {
      const ssh = fakeSsh();
      ssh.state.resumeFailure = failure;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const error = yield* executor
          .prepare(
            new CheckoutRequest({
              ...request,
              resume: Option.some(
                new SalvagePushed({
                  ref: SalvageRef.make("usine/salvage/r/1"),
                  commit: SALVAGE_COMMIT,
                }),
              ),
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "ExecutorOperationError");
        assert(
          !ssh.state.commands.some((command) => remoteLine(command).includes("'worktree' 'add'")),
        );
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect.each(["inspect-fails", "add-fails", "commit-fails"] as const)(
    "preserves the checkout through scope cleanup when %s",
    (failure) => {
      const ssh = fakeSsh();
      ssh.state.salvage = failure;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const cleanupStart = ssh.state.commands.length;
        const recorded: Array<AttemptSalvage> = [];
        yield* prepared
          .launch({
            append: () => Effect.void,
            comments: () => Effect.void,
            salvage: (value) =>
              Effect.sync(() => {
                recorded.push(value);
              }),
          })
          .pipe(Effect.flip);
        assert(recorded[0]?._tag === "Retained");
        const lines = ssh.state.commands.slice(cleanupStart).map(remoteLine);
        assert(
          !lines.some(
            (line) => line.includes("'worktree' 'remove'") || line.startsWith("exec 'rm' '-rf'"),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, fails)));
    },
  );

  it.effect("renews grants beyond their original lifetime and stops renewal after release", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      yield* TestClock.adjust("3 hours");
      assert(ssh.state.commands.filter(({ args }) => args.includes("attach")).length > 3);
      yield* prepared.launch({
        append: () => Effect.void,
        salvage: () => Effect.void,
        comments: () => Effect.void,
      });
      const released = ssh.state.commands.length;
      yield* TestClock.adjust("2 hours");
      assert.strictEqual(ssh.state.commands.length, released);
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("retries a failed grant renewal every minute instead of at the next half-life", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.prepare(request);
      const attaches = () =>
        ssh.state.commands.filter(({ args }) => args.includes("attach")).length;
      assert.strictEqual(attaches(), 1);
      ssh.state.failAttach = true;
      // The first renewal is due at half the 65-minute grant.
      yield* TestClock.adjust("33 minutes");
      const failed = attaches();
      assert(failed >= 2, "the half-life renewal never ran");
      ssh.state.failAttach = false;
      yield* TestClock.adjust("2 minutes");
      assert(attaches() > failed, "a failed renewal must be retried within minutes");
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect(
    "reconciles a remote crash checkout and records the pushed salvage before removal",
    () => {
      const ssh = fakeSsh();
      ssh.state.cacheExists = true;
      ssh.state.salvage = "dirty";
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.recover(
          {
            attemptId: request.attemptId,
            repository: request.repository,
            worker: WORKER,
            ref: request.salvageRef,
            permissions: "write",
            succeeded: false,
            open: false,
          },
          (salvage) =>
            Effect.sync(() => {
              assert.strictEqual(salvage._tag, "Pushed");
              assert(
                !ssh.state.commands.some((command) =>
                  remoteLine(command).includes("'worktree' 'remove'"),
                ),
              );
            }),
        );
        const lines = ssh.state.commands.map(remoteLine);
        const stop = lines.findIndex((line) => line.startsWith("exec 'sh' '-c'"));
        assert(stop >= 0, "recovery must stop the Attempt's remote children");
        assert(lines.some((line, index) => index > stop && line.includes("'worktree' 'remove'")));
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect("leaves the checkout of a live open Attempt for its reattachment", () => {
    const ssh = fakeSsh();
    ssh.state.cacheExists = true;
    const started = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      yield* prepared
        .launch({
          append: () => Effect.void,
          salvage: () => Effect.void,
          comments: () => Effect.void,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const before = ssh.state.commands.length;
      yield* executor.recover(
        {
          attemptId: request.attemptId,
          repository: request.repository,
          worker: WORKER,
          ref: request.salvageRef,
          permissions: "write",
          succeeded: false,
          open: true,
        },
        () => Effect.void,
      );
      assert.strictEqual(ssh.state.commands.length, before);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        runtime(ssh.layer, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    );
  });

  it.effect(
    "removes the checkout retained by a failed remote stop on a succeeded Attempt without salvage",
    () => {
      const ssh = fakeSsh();
      ssh.state.salvage = "dirty";
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const owner = yield* Scope.make();
        const prepared = yield* executor.prepare(request).pipe(Scope.provide(owner));
        ssh.state.failStop = true;
        const result = yield* prepared.launch({
          append: () => Effect.void,
          salvage: () => Effect.void,
          comments: () => Effect.void,
        });
        assert.strictEqual(result.message, `Completed: ${request.task}`);
        yield* Scope.close(owner, Exit.void);
        ssh.state.failStop = false;
        const reconciled = ssh.state.commands.length;
        const recorded: Array<AttemptSalvage> = [];
        yield* executor.recover(
          {
            attemptId: request.attemptId,
            repository: request.repository,
            worker: WORKER,
            ref: request.salvageRef,
            permissions: "write",
            succeeded: true,
            open: false,
          },
          (salvage) => Effect.sync(() => void recorded.push(salvage)),
        );
        const remote = ssh.state.commands.slice(reconciled).map(remoteLine);
        assert.strictEqual(recorded.length, 0);
        assert(remote.some((line) => line.startsWith("exec 'sh' '-c'")));
        assert(remote.some((line) => line.includes("'worktree' 'remove' '--force'")));
        assert(!remote.some((line) => line.includes("'status'")));
        assert(!remote.some((line) => line.includes("'commit'")));
        assert(!remote.some((line) => line.includes("'push'")));
        assert(!ssh.state.commands.slice(reconciled).some(({ args }) => args.includes("attach")));
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect("reconciles Attempts that left no checkout from one listing of their Worker", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const recorded: Array<AttemptSalvage> = [];
      // Reconciliation visits the whole Attempt history, succeeded or not.
      for (const [index, succeeded] of [true, false, true, true].entries()) {
        yield* executor.recover(
          {
            attemptId: AttemptId.make(`finished-run/execute/${index + 1}`),
            repository: request.repository,
            worker: WORKER,
            ref: SalvageRef.make(`usine/salvage/finished-run/${index + 1}`),
            permissions: "write",
            succeeded,
            open: false,
          },
          (salvage) => Effect.sync(() => void recorded.push(salvage)),
        );
      }
      const remote = ssh.state.commands.map(remoteLine);
      assert.strictEqual(recorded.length, 0);
      assert.strictEqual(remote.filter((line) => line.startsWith("exec 'find' ")).length, 1);
      assert(!remote.some((line) => line.startsWith("exec 'test' ")));
      assert(!remote.some((line) => line.startsWith("exec 'sh' '-c'")));
      assert(!remote.some((line) => line.startsWith("exec 'git' ")));
      // The Worker is resolved once, not once per Attempt.
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("exe.dev") && args.includes("ls"))
          .length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("fails every Attempt of a Worker that is gone after one lookup", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      for (const index of [1, 2, 3]) {
        const exit = yield* executor
          .recover(
            {
              attemptId: AttemptId.make(`orphaned-run/execute/${index}`),
              repository: request.repository,
              worker: WorkerName.make("decommissioned"),
              ref: SalvageRef.make(`usine/salvage/orphaned-run/${index}`),
              permissions: "write",
              succeeded: index !== 2,
              open: false,
            },
            () => Effect.void,
          )
          .pipe(Effect.exit);
        assert(Exit.isFailure(exit));
        assert(Cause.pretty(exit.cause).includes("exe.dev has no VM named decommissioned"));
      }
      assert.strictEqual(ssh.state.commands.length, 1);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("preflight verifies the baked VM without changing remote state", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      for (const command of ssh.state.commands) {
        const line = remoteLine(command);
        for (const mutating of [
          "attach",
          "clone",
          "detach",
          "find",
          "mkdir",
          "mv",
          "prune",
          "rm",
        ]) {
          assert(
            !command.args.includes(mutating) && !line.includes(`'${mutating}'`),
            `preflight invoked ${mutating}`,
          );
        }
      }
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("contains an invalid sweep boundary without touching it or blocking prepare", () => {
    const ssh = fakeSsh("invalid-path");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      // The sweep failure is isolated: prepare proceeds, and the path outside
      // the Worker root is never touched.
      const prepared = yield* executor.prepare(request);
      assert.strictEqual(prepared.workspace.spec.attemptId, ATTEMPT_ID);
      assert.deepStrictEqual(prepared.workspace.spec.payload, request.payload);
      assert.deepStrictEqual(prepared.workspace.spec.agent, request.agent);
      assert.deepStrictEqual(prepared.workspace.spec.parentModel, request.parentModel);
      const commandLine = ssh.state.commands.map(({ args }) => args.join(" ")).join("\n");
      assert(!commandLine.includes("/tmp/not-a-worker-child"));
      assert(commandLine.includes("integrations attach"));
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("preserves success and a sibling's credentials when worktree cleanup fails", () => {
    const ssh = fakeSsh();
    const errors: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Error") errors.push(message);
    });
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const prepared = yield* executor.prepare(request).pipe(Scope.provide(firstScope));
      yield* executor
        .prepare(
          new CheckoutRequest({
            ...request,
            attemptId: AttemptId.make("remote-run/execute/2"),
          }),
        )
        .pipe(Scope.provide(secondScope));
      ssh.state.failWorktreeRm = true;
      const result = yield* prepared.launch({
        append: () => Effect.void,
        salvage: () => Effect.void,
        comments: () => Effect.void,
      });
      assert.strictEqual(result.message, `Completed: ${request.task}`);
      assert(JSON.stringify(errors).includes("worktree-directory"));
      assert(
        ssh.state.commands.some((command) => remoteLine(command).includes("'worktree' 'prune'")),
      );
      const detaches = () =>
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length;
      assert.strictEqual(detaches(), 0);
      const issued = ssh.state.commands.length;
      yield* Scope.close(firstScope, Exit.void);
      yield* Scope.close(firstScope, Exit.void);
      assert.strictEqual(ssh.state.commands.length, issued);
      yield* Scope.close(secondScope, Exit.void);
      assert.strictEqual(detaches(), 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(runtime(ssh.layer)),
      Effect.provide(Logger.layer([logger])),
    );
  });

  it.effect(
    "retains the checkout when stopping its remote children fails without changing success or leaking the grant",
    () => {
      const ssh = fakeSsh();
      const errors: Array<unknown> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Error") errors.push(message);
      });
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const owner = yield* Scope.make();
        const prepared = yield* executor.prepare(request).pipe(Scope.provide(owner));
        ssh.state.failStop = true;
        const beforeLaunch = ssh.state.commands.length;
        const result = yield* prepared.launch({
          append: () => Effect.void,
          salvage: () => Effect.void,
          comments: () => Effect.void,
        });
        assert.strictEqual(result.message, `Completed: ${request.task}`);
        const issued = ssh.state.commands.slice(beforeLaunch);
        const remote = issued.map(remoteLine);
        assert(remote.some((line) => line.startsWith("exec 'sh' '-c'")));
        assert(!remote.some((line) => line.includes("'worktree' 'remove'")));
        assert(!remote.some((line) => line.includes("'worktree' 'prune'")));
        assert(!remote.some((line) => line.startsWith("exec 'rm'")));
        assert.strictEqual(issued.filter(({ args }) => args.includes("detach")).length, 1);
        assert(JSON.stringify(errors).includes("retained for recovery"));
        assert(JSON.stringify(errors).includes(prepared.workspace.worktree));
        const completed = ssh.state.commands.length;
        yield* Scope.close(owner, Exit.void);
        yield* Scope.close(owner, Exit.void);
        assert.strictEqual(ssh.state.commands.length, completed);
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(ssh.layer)),
        Effect.provide(Logger.layer([logger])),
      );
    },
  );

  for (const phase of ["preflight", "clone", "fetch", "attach", "promotion", "checkout"] as const) {
    it.effect(
      `cancels preparation during ${phase} before launching and releases acquired resources`,
      () => {
        const ssh = fakeSsh();
        // Partial preparation has never started a child and must roll back
        // without requiring a working remote stop.
        ssh.state.failStop = true;
        return Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
          ssh.state.hangPreparation = phase;
          const fiber = yield* Effect.forkChild(executor.prepare(request));
          while (!ssh.state.parked) yield* Effect.yieldNow;
          yield* executor.cancel(ATTEMPT_ID);
          const exit = yield* Fiber.await(fiber);
          assert(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
          yield* executor.cancel(ATTEMPT_ID);
          assert.strictEqual(
            ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
            phase === "preflight" ? 0 : 1,
          );
          if (phase === "checkout") {
            const commands = ssh.state.commands.map(remoteLine);
            const add = commands.findIndex((line) => line.includes("'worktree' 'add'"));
            assert(
              commands.some((line, index) => index > add && line.includes("'worktree' 'remove'")),
            );
            assert(
              commands.some((line, index) => index > add && line.includes("'worktree' 'prune'")),
            );
          }
          if (phase === "clone" || phase === "promotion") {
            const commands = ssh.state.commands.map(remoteLine);
            const clone = commands.findIndex((line) => line.includes("'clone'"));
            assert(
              commands.some(
                (line, index) =>
                  index > clone && line.startsWith("exec 'rm' '-rf'") && line.includes(".cloning"),
              ),
            );
          }
        }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
      },
    );
  }

  it.effect("canceling a prepared Attempt prevents a later launch and releases its grant", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      yield* executor.cancel(ATTEMPT_ID);
      yield* executor.cancel(ATTEMPT_ID);
      const error = yield* prepared
        .launch({
          append: () => Effect.void,
          salvage: () => Effect.void,
          comments: () => Effect.void,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "InfraFailure");
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("a cancel during checkout holds the Attempt until its resources are released", () => {
    const ssh = fakeSsh();
    const detaches = () => ssh.state.commands.filter(({ args }) => args.includes("detach")).length;
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      ssh.state.hangPreparation = "checkout";
      const attempt = Effect.gen(function* () {
        const prepared = yield* executor.prepare(request);
        return yield* prepared.launch({
          append: () => Effect.void,
          salvage: () => Effect.void,
          comments: () => Effect.void,
        });
      }).pipe(Effect.scoped);
      // The grant detaches last, so its count at the owner's exit shows whether
      // the owner returned while the canceling fiber was still cleaning up.
      const released = yield* attempt.pipe(Effect.exit, Effect.map(detaches), Effect.forkChild);
      while (!ssh.state.parked) yield* Effect.yieldNow;
      const canceling = yield* Effect.forkChild(executor.cancel(ATTEMPT_ID));
      assert.strictEqual(yield* Fiber.join(released), 1);
      yield* Fiber.join(canceling);
      assert.strictEqual(detaches(), 1);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("does not release a sibling's grant when canceled while waiting for its clone", () => {
    const ssh = fakeSsh();
    ssh.state.hangPreparation = "clone";
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      const first = yield* executor.prepare(request).pipe(Effect.scoped, Effect.forkChild);
      while (!ssh.state.commands.some((command) => remoteLine(command).includes("'clone'"))) {
        yield* Effect.yieldNow;
      }
      const waiting = yield* executor
        .prepare(
          new CheckoutRequest({
            ...request,
            attemptId: AttemptId.make("remote-run/execute/2"),
          }),
        )
        .pipe(Effect.scoped, Effect.forkChild);
      // Let the second prepare reach the held repository lock.
      for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
      yield* executor.cancel(AttemptId.make("remote-run/execute/2"));
      const exit = yield* Fiber.await(waiting);
      assert(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        0,
      );
      yield* Fiber.interrupt(first);
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("refreshes a shared grant for each Attempt and detaches after the last cleanup", () => {
    const ssh = fakeSsh();
    const secondRequest = new CheckoutRequest({
      ...request,
      attemptId: AttemptId.make("remote-run/execute/2"),
    });
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      const first = yield* Scope.make();
      const second = yield* Scope.make();
      yield* executor.prepare(request).pipe(Scope.provide(first));
      yield* executor.prepare(secondRequest).pipe(Scope.provide(second));
      const matchingCommands = (subcommand: string) =>
        ssh.state.commands.filter(
          ({ args }) => args.includes("integrations") && args.includes(subcommand),
        );
      assert.strictEqual(matchingCommands("attach").length, 2);
      yield* Scope.close(first, Exit.void);
      assert.strictEqual(matchingCommands("detach").length, 0);
      yield* Scope.close(second, Exit.void);
      assert.strictEqual(matchingCommands("detach").length, 1);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("does not detach a live sibling after an ambiguous grant refresh failure", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      const owner = yield* Scope.make();
      yield* executor.prepare(request).pipe(Scope.provide(owner));
      ssh.state.failAttach = true;
      const error = yield* executor
        .prepare(
          new CheckoutRequest({
            ...request,
            attemptId: AttemptId.make("remote-run/execute/2"),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "CredentialUnavailableError");
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        0,
      );
      yield* Scope.close(owner, Exit.void);
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });
});

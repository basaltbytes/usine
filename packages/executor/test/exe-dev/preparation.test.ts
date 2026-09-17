import { assert, describe, it } from "@effect/vitest";

import { AttemptId } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";

import { CheckoutRequest, Executor } from "../../src/executor.ts";

import { Cause, Effect, Exit, Fiber, Logger, Scope } from "effect";

import {
  ATTEMPT_ID,
  WORKER,
  PROTOCOL,
  TEST_AGENT,
  SSH_ENVIRONMENT_ALLOWLIST,
  remoteArgs,
  fakeSsh,
  request,
  runtime,
} from "./support.ts";

describe("exe.dev preparation", () => {
  it.effect("preflight verifies the baked VM without changing remote state", () => {
    const ssh = fakeSsh(PROTOCOL);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      for (const command of ssh.state.commands) {
        const remoteLine = remoteArgs(command)[0] ?? "";
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
            !command.args.includes(mutating) && !remoteLine.includes(`'${mutating}'`),
            `preflight invoked ${mutating}`,
          );
        }
      }
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("contains an invalid sweep boundary without touching it or blocking prepare", () => {
    const ssh = fakeSsh(PROTOCOL, "success", "invalid-path");
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
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
    const ssh = fakeSsh(PROTOCOL);
    const errors: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Error") errors.push(message);
    });
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
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
      const result = yield* prepared.launch({ append: () => Effect.void });
      assert.strictEqual(result.message, "done");
      assert(JSON.stringify(errors).includes("worktree-directory"));
      assert(
        ssh.state.commands.some((command) =>
          (remoteArgs(command)[0] ?? "").includes("'worktree' 'prune'"),
        ),
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
    "retains the checkout when remote termination fails without changing success or leaking the grant",
    () => {
      const ssh = fakeSsh(PROTOCOL);
      const errors: Array<unknown> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Error") errors.push(message);
      });
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
        const owner = yield* Scope.make();
        const prepared = yield* executor.prepare(request).pipe(Scope.provide(owner));
        ssh.state.failStop = true;
        const beforeLaunch = ssh.state.commands.length;
        const result = yield* prepared.launch({ append: () => Effect.void });
        assert.strictEqual(result.message, "done");
        const issued = ssh.state.commands.slice(beforeLaunch);
        const remote = issued.map((command) => remoteArgs(command)[0] ?? "");
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
        const ssh = fakeSsh(PROTOCOL);
        // Partial preparation has never launched a run host and must roll back
        // without requiring a working remote-stop channel.
        ssh.state.failStop = true;
        return Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
          ssh.state.hangPreparation = phase;
          const fiber = yield* Effect.forkChild(executor.prepare(request));
          while (!ssh.state.parked) yield* Effect.yieldNow;
          yield* executor.cancel(ATTEMPT_ID);
          const exit = yield* Fiber.await(fiber);
          assert(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
          yield* executor.cancel(ATTEMPT_ID);
          assert.deepStrictEqual(ssh.state.inputs, []);
          assert.strictEqual(
            ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
            phase === "preflight" ? 0 : 1,
          );
          if (phase === "checkout") {
            const commands = ssh.state.commands.map((command) => remoteArgs(command)[0] ?? "");
            const add = commands.findIndex((line) => line.includes("'worktree' 'add'"));
            assert(
              commands.some((line, index) => index > add && line.includes("'worktree' 'remove'")),
            );
            assert(
              commands.some((line, index) => index > add && line.includes("'worktree' 'prune'")),
            );
          }
          if (phase === "clone" || phase === "promotion") {
            const commands = ssh.state.commands.map((command) => remoteArgs(command)[0] ?? "");
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
    const ssh = fakeSsh(PROTOCOL);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      yield* executor.cancel(ATTEMPT_ID);
      yield* executor.cancel(ATTEMPT_ID);
      const error = yield* prepared.launch({ append: () => Effect.void }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "InfraFailure");
      assert.deepStrictEqual(ssh.state.inputs, []);
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  it.effect("canceling a pending process spawn prevents the Start frame", () => {
    const ssh = fakeSsh(PROTOCOL);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      ssh.state.hangPreparation = "spawn";
      const launched = yield* prepared.launch({ append: () => Effect.void }).pipe(Effect.forkChild);
      while (!ssh.state.parked) yield* Effect.yieldNow;
      yield* executor.cancel(ATTEMPT_ID);
      const exit = yield* Fiber.await(launched);
      assert(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      assert.deepStrictEqual(ssh.state.inputs, []);
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
  });

  for (const stage of ["checkout", "spawn"] as const) {
    it.effect(`a cancel during ${stage} holds the Attempt until its resources are released`, () => {
      const ssh = fakeSsh(PROTOCOL);
      const detaches = () =>
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length;
      return Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
        ssh.state.hangPreparation = stage;
        const attempt = Effect.gen(function* () {
          const prepared = yield* executor.prepare(request);
          return yield* prepared.launch({ append: () => Effect.void });
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
  }

  it.effect("does not release a sibling's grant when canceled while waiting for its clone", () => {
    const ssh = fakeSsh(PROTOCOL);
    ssh.state.hangPreparation = "clone";
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
      const first = yield* executor.prepare(request).pipe(Effect.scoped, Effect.forkChild);
      while (
        !ssh.state.commands.some((command) => (remoteArgs(command)[0] ?? "").includes("'clone'"))
      ) {
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

  it.effect(
    "runs unchanged Attempt envelopes over SSH and cleans the edge grant and worktree",
    () => {
      const ssh = fakeSsh(PROTOCOL);
      const transcript: Array<[AttemptChannel.Direction, AttemptChannel.Envelope]> = [];
      return Effect.gen(function* () {
        const executor = yield* Executor;
        assert.strictEqual(executor.kind, "exe.dev");
        yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
        const prepared = yield* executor.prepare(request);
        const result = yield* prepared.launch({
          append: (direction, envelope) =>
            Effect.sync(() => {
              transcript.push([direction, envelope]);
            }),
        });
        assert.strictEqual(result.message, "done");
        assert.deepStrictEqual(
          transcript.map(([direction, envelope]) => [direction, envelope.payload._tag]),
          [
            ["outbound", "Started"],
            ["outbound", "SessionEvent"],
            ["outbound", "Final"],
          ],
        );
        assert.deepStrictEqual(
          ssh.state.inputs.map((input) => input._tag),
          ["Start"],
        );
        const start = ssh.state.inputs[0];
        assert(start?._tag === "Start");
        assert.deepStrictEqual(start.spec, prepared.workspace.spec);

        const commandLines = ssh.state.commands.map(({ args }) => args.join(" "));
        assert(commandLines.some((line) => line.includes("integrations test usine-acme-demo")));
        assert(
          commandLines.some((line) =>
            line.includes("integrations attach usine-acme-demo vm:remote-one --for 65m"),
          ),
        );
        assert(
          commandLines.some((line) => line.includes("https://github.int.exe.xyz/acme/demo.git")),
        );
        assert(commandLines.some((line) => line.includes("export GH_HOST=github.int.exe.xyz")));
        assert(
          commandLines.some((line) => line.includes("'main;$(touch$IFS/tmp/usine-injected)'")),
        );
        assert(commandLines.some((line) => line.includes("integrations detach usine-acme-demo")));
        assert(
          commandLines.some((line) => line.includes("attempts/abandoned-attempt")),
          "the first prepare must sweep a crash-leftover worktree",
        );
        assert(
          commandLines.some(
            (line) => line.includes("repos/acme_demo.git") && line.includes("worktree' 'prune"),
          ),
          "the first prepare must prune crash-leftover cache registrations",
        );
        for (const command of ssh.state.commands) {
          assert.strictEqual(command.options.extendEnv, false);
          for (const name of Object.keys(command.options.env ?? {})) {
            assert(SSH_ENVIRONMENT_ALLOWLIST.has(name), `unexpected SSH environment key: ${name}`);
          }
          assert(!("USINE_GITHUB_PRIVATE_KEY" in (command.options.env ?? {})));
          assert(!("GH_TOKEN" in (command.options.env ?? {})));
          assert(!("GITHUB_TOKEN" in (command.options.env ?? {})));
          if (command.args.includes("integrations")) assert(!command.args.includes("--json"));
          const separator = command.args.indexOf("--");
          if (separator >= 0) assert.strictEqual(command.args.slice(separator + 1).length, 1);
        }
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer)));
    },
  );

  it.effect("refreshes a shared grant for each Attempt and detaches after the last cleanup", () => {
    const ssh = fakeSsh(PROTOCOL);
    const secondRequest = new CheckoutRequest({
      ...request,
      attemptId: AttemptId.make("remote-run/execute/2"),
    });
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
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
    const ssh = fakeSsh(PROTOCOL);
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain]);
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

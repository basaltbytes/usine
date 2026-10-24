import { assert, describe, it } from "@effect/vitest";
import { CHILD_KILL_SCRIPT, RemoteShell } from "@usine/agents/child-host";
import { githubSignature } from "@usine/core/agent";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { AttemptId, AttemptWindow, AttemptWindows } from "@usine/core/attempt";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { InfraFailure } from "@usine/core/attempt/failure";
import type { AttemptRecovery } from "@usine/core/attempt/salvage";
import { BotLogin } from "@usine/core/worker";
import { type AttemptRequest, AttemptRuntime, ParentFailed } from "@usine/durable/attempt-runtime";
import { completes, type StubParent, StubStorage } from "@usine/durable/testing";
import { DateTime, Deferred, Effect, Fiber, Layer, Logger, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { CheckoutRequest, Executor } from "../../src/executor.ts";
import {
  aloneOnItem,
  ATTEMPT_ID,
  BOT_COMMITS,
  COMMIT_AUTHOR,
  SSH_ENVIRONMENT_ALLOWLIST,
  TEST_AGENT,
  WORKER,
  WORKTREE,
  fails,
  fakeSsh,
  recording,
  remoteLine,
  request,
  runtime,
} from "./support.ts";

const KILL_CHILDREN = `exec 'sh' '-c' '${CHILD_KILL_SCRIPT.replaceAll("'", `'"'"'`)}' 'sh' '${WORKTREE}'`;

/** A parent that reports it started, then runs until its task is canceled or the process stops. */
const working =
  (started: Deferred.Deferred<void>): StubParent =>
  () =>
    Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));

/** Runs the Attempt in one orchestrator process and stops the process mid-Attempt. */
const stopMidAttempt = (
  ssh: ReturnType<typeof fakeSsh>,
  storage: StubStorage,
  checkout: CheckoutRequest = request,
) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
      const prepared = yield* executor.prepare(checkout);
      const launch = yield* prepared.launch(recording().sink).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(launch);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, working(started), storage)));
  });

const COMMENT = "https://github.com/acme/demo/issues/42#issuecomment-7";
/** A comment posted at 10:07, while another Attempt of the same Agent was open on issue 42. */
const SHARED = "https://github.com/acme/demo/issues/42#issuecomment-8";

/** Another Loop's Attempt of the same Agent, open on issue 42 since 10:05. */
const OTHER_ATTEMPT = new AttemptWindow({
  attemptId: AttemptId.make("docs-run/implement/1"),
  startedAt: DateTime.makeUnsafe("2026-10-20T10:05:00Z"),
  endedAt: Option.none(),
});

/** The Attempt on issue 42, with the bot login that the fake `gh` lists comments for. */
const onItem = new CheckoutRequest({
  ...request,
  payload: { number: 42, url: "https://github.com/acme/demo/issues/42" },
  botLogin: Option.some(BotLogin.make("usine-test[bot]")),
});

/** Makes the fake `gh` list `COMMENT` and `SHARED` on issue 42, both signed by the Attempt's Agent. */
const postSignedComment = (ssh: ReturnType<typeof fakeSsh>) => {
  const signed = (url: string, at: string) => ({
    html_url: url,
    body: `Fixed.\n\n${githubSignature(TEST_AGENT.name)}`,
    user: { login: "usine-test[bot]" },
    created_at: at,
    updated_at: at,
  });
  ssh.state.issueComments = JSON.stringify([
    [signed(COMMENT, "2026-10-20T10:00:00Z"), signed(SHARED, "2026-10-20T10:07:00Z")],
  ]);
};

/** The open Attempt as startup reconciliation finds it after a restart. */
const openAttempt: AttemptRecovery = {
  attemptId: ATTEMPT_ID,
  repository: request.repository,
  worker: WORKER,
  ref: request.salvageRef,
  permissions: "write",
  succeeded: false,
  open: true,
};

/**
 * Returns a stub runtime where durable storage has `ParentFailed`: the parent task failed and
 * the previous process stopped before recording the failure.
 */
const parentFailed = (stub: Layer.Layer<AttemptRuntime>) =>
  Layer.effect(
    AttemptRuntime,
    Effect.map(AttemptRuntime, (runtime) =>
      AttemptRuntime.of({
        ...runtime,
        isLive: () => Effect.succeed(false),
        finished: () =>
          Effect.succeed(
            Option.some(
              new ParentFailed({
                failure: new InfraFailure({ message: "The parent stopped", cause: "crash" }),
              }),
            ),
          ),
      }),
    ),
  ).pipe(Layer.provide(stub));

/**
 * Returns a stub runtime that fails to record a harvested result, so the report stays
 * `ParentReported` and `isLive` keeps returning true.
 */
const failingResultWrite = (stub: Layer.Layer<AttemptRuntime>) =>
  Layer.effect(
    AttemptRuntime,
    Effect.map(AttemptRuntime, (runtime) =>
      AttemptRuntime.of({
        ...runtime,
        recordResult: () =>
          new InfraFailure({ message: "Result write failed", cause: "storage unavailable" }),
      }),
    ),
  ).pipe(Layer.provide(stub));

describe("exe.dev launch", () => {
  it.effect("keeps a completed checkout when its harvested result could not be stored", () => {
    const ssh = fakeSsh();
    const storage = new StubStorage();
    const { transcript, sink } = recording();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const result = yield* prepared.launch(sink);
        assert.strictEqual(result.message, `Completed: ${request.task}`);
        assert.isTrue(yield* executor.isLive(ATTEMPT_ID));
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(ssh.layer, completes, storage, failingResultWrite)),
      );
      assert(
        !ssh.state.commands.map(remoteLine).some((line) => line.includes("'worktree' 'remove'")),
        "the checkout must survive until its result is durable",
      );
      // The process stopped before the engine recorded the result. A new runtime harvests the same
      // checkout from the stored parent report.
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(
          new CheckoutRequest({ ...request, reattach: true }),
        );
        const result = yield* prepared.launch(sink);
        assert.strictEqual(result.message, `Completed: ${request.task}`);
        assert.isFalse(yield* executor.isLive(ATTEMPT_ID));
        assert(
          ssh.state.commands.map(remoteLine).some((line) => line.includes("'worktree' 'remove'")),
          "the recorded result permits checkout cleanup",
        );
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, fails, storage)));
      assert.strictEqual(
        transcript.filter(([, envelope]) => envelope.payload._tag === "Final").length,
        1,
      );
    });
  });

  it.effect(
    "salvages the checkout of an open Attempt its Run does not reattach, though its parent's report was not harvested",
    () => {
      const ssh = fakeSsh();
      const storage = new StubStorage();
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const prepared = yield* executor.prepare(request);
          yield* prepared.launch(recording().sink);
        }).pipe(
          Effect.scoped,
          Effect.provide(runtime(ssh.layer, completes, storage, failingResultWrite)),
        );
        // After the restart, the Run closes the Attempt without reattaching it, for example when it
        // can't read whether the parent task is live.
        ssh.state.salvage = "dirty";
        const salvaged: Array<string> = [];
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          assert.isTrue(yield* executor.isLive(ATTEMPT_ID), "the report awaits its harvest");
          yield* executor.recover(
            openAttempt,
            {
              salvage: (salvage) => Effect.sync(() => void salvaged.push(salvage._tag)),
              comments: () => Effect.die("A parent that reported posted no comment to recover"),
              windows: aloneOnItem(),
            },
            Effect.succeed(COMMIT_AUTHOR),
          );
        }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, fails, storage)));
        assert.deepStrictEqual(salvaged, ["Pushed"]);
        const lines = ssh.state.commands.map(remoteLine);
        // exe.dev's integration pushes the salvage, but the factory App's bot commits it.
        assert.include(
          lines.find((line) => line.includes("'commit' '--quiet'")) ?? "",
          BOT_COMMITS,
        );
        assert(lines.some((line) => line.includes("'worktree' 'remove'")));
      });
    },
  );

  it.effect(
    "cancels the parent task of an open Attempt its Run does not reattach, then salvages its checkout",
    () => {
      const ssh = fakeSsh();
      const storage = new StubStorage();
      return Effect.gen(function* () {
        yield* stopMidAttempt(ssh, storage);
        ssh.state.salvage = "dirty";
        const salvaged: Array<string> = [];
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          assert.isTrue(yield* executor.isLive(ATTEMPT_ID), "the parent task outlived the restart");
          yield* executor.recover(
            openAttempt,
            {
              salvage: (salvage) => Effect.sync(() => void salvaged.push(salvage._tag)),
              comments: () => Effect.die("A canceled parent posted no comment to recover"),
              windows: aloneOnItem(),
            },
            Effect.succeed(COMMIT_AUTHOR),
          );
          assert.isFalse(yield* executor.isLive(ATTEMPT_ID));
        }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, completes, storage)));
        assert.deepStrictEqual(salvaged, ["Pushed"]);
      });
    },
  );

  it.effect(
    "keeps the checkout of an open Attempt whose parent task it cannot confirm stopped",
    () => {
      const ssh = fakeSsh();
      const storage = new StubStorage();
      // The parent task is still running after the restart, and durable storage fails to cancel it.
      const failingCancel = (stub: Layer.Layer<AttemptRuntime>) =>
        Layer.effect(
          AttemptRuntime,
          Effect.map(AttemptRuntime, (runtime) =>
            AttemptRuntime.of({
              ...runtime,
              cancel: () =>
                new InfraFailure({ message: "Cancel failed", cause: "storage unavailable" }),
            }),
          ),
        ).pipe(Layer.provide(stub));
      return Effect.gen(function* () {
        yield* stopMidAttempt(ssh, storage);
        ssh.state.salvage = "dirty";
        const salvaged: Array<string> = [];
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const recovered = yield* executor
            .recover(
              openAttempt,
              {
                salvage: (salvage) => Effect.sync(() => void salvaged.push(salvage._tag)),
                comments: () => Effect.die("A parent that may still run has no comment recovered"),
                windows: aloneOnItem(),
              },
              Effect.die("A parent that may still run has no salvage to commit"),
            )
            .pipe(Effect.flip);
          assert(recovered._tag === "ExecutorOperationError");
          assert.strictEqual(recovered.operation, "cancel");
          const canceled = yield* executor.cancel(ATTEMPT_ID).pipe(Effect.flip);
          assert(canceled._tag === "ExecutorOperationError");
          assert.strictEqual(canceled.operation, "cancel");
          assert.isTrue(yield* executor.isLive(ATTEMPT_ID), "the parent task may still run");
        }).pipe(
          Effect.scoped,
          Effect.provide(runtime(ssh.layer, completes, storage, failingCancel)),
        );
        assert.deepStrictEqual(salvaged, []);
        assert(
          !ssh.state.commands.map(remoteLine).some((line) => line.includes("'worktree' 'remove'")),
          "the checkout stays while its parent task may still write to it",
        );
      });
    },
  );

  it.effect(
    "runs the parent in this process with the VM as the child host, then harvests and cleans up over SSH",
    () => {
      const ssh = fakeSsh();
      const { transcript, sink } = recording();
      let given: AttemptRequest | undefined;
      const parent: StubParent = (context) => {
        given = context.request;
        return completes(context);
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        assert.strictEqual(executor.kind, "exe.dev");
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const prepared = yield* executor.prepare(request);
        const result = yield* prepared.launch(sink);
        assert.strictEqual(result.message, `Completed: ${request.task}`);
        assert.deepStrictEqual(result.facts, []);
        assert.deepStrictEqual(transcript.at(0)?.[1].payload._tag, "Started");
        assert.deepStrictEqual(transcript.at(-1)?.[1].payload._tag, "Final");

        assert(given !== undefined);
        assert.strictEqual(given.cwd, WORKTREE);
        assert.deepStrictEqual(given.spec, prepared.workspace.spec);
        // exe.dev's integration pushes, but the factory App's bot authors and commits.
        assert.deepStrictEqual(given.environment, {
          GH_HOST: "github.int.exe.xyz",
          GIT_AUTHOR_NAME: COMMIT_AUTHOR.login,
          GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.noreplyEmail,
          GIT_COMMITTER_NAME: COMMIT_AUTHOR.login,
          GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.noreplyEmail,
        });
        assert(given.host instanceof RemoteShell);
        assert.strictEqual(given.host.destination, "remote-one.exe.xyz");
        assert.strictEqual(given.host.ssh.command, "ssh");
        assert.include(given.host.ssh.args, "BatchMode=yes");
        for (const name of Object.keys(given.host.sshEnvironment))
          assert(SSH_ENVIRONMENT_ALLOWLIST.has(name), `unexpected SSH environment key: ${name}`);

        const lines = ssh.state.commands.map(remoteLine);
        const harvest = `cd '${WORKTREE}' && export GH_HOST='github.int.exe.xyz' && exec 'git' 'log' '--reverse' '--format=%H %s' '${prepared.workspace.spec.baseCommit}..HEAD'`;
        assert.include(lines, harvest);
        const stop = lines.indexOf(KILL_CHILDREN);
        const remove = lines.findIndex((line) => line.includes("'worktree' 'remove'"));
        assert(stop > lines.indexOf(harvest), "children are stopped once the parent finished");
        assert(remove > stop, "the worktree is removed only after its children are stopped");

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
        assert(
          commandLines.some((line) => line.includes("'main;$(touch$IFS/tmp/usine-injected)'")),
        );
        assert(commandLines.some((line) => line.includes("integrations detach usine-acme-demo")));
        assert(
          !commandLines.some((line) => line.includes("attempts/abandoned-attempt")),
          "unknown crash leftovers must stay untouched",
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
          if (command.args.includes("integrations")) assert(!command.args.includes("--json"));
          const separator = command.args.indexOf("--");
          if (separator >= 0) assert.strictEqual(command.args.slice(separator + 1).length, 1);
        }
        assert.isFalse(yield* executor.isLive(ATTEMPT_ID));
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, parent)));
    },
  );

  it.effect(
    "repeated cancellation preserves the parent failure and releases remote resources once",
    () => {
      const ssh = fakeSsh();
      const started = Deferred.makeUnsafe<void>();
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const launch = yield* prepared.launch(recording().sink).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        assert.isTrue(yield* executor.isLive(ATTEMPT_ID));
        const before = ssh.state.commands.length;
        const released = yield* executor
          .cancel(ATTEMPT_ID)
          .pipe(
            Effect.map(
              () => ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
            ),
          );
        yield* executor.cancel(ATTEMPT_ID);
        const failure = yield* Fiber.join(launch).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AgentFailure");
        assert.strictEqual(failure.message, "The parent task was canceled");
        assert.strictEqual(released, 1, "cancel waits for resource release");
        const lines = ssh.state.commands.slice(before).map(remoteLine);
        const stop = lines.indexOf(KILL_CHILDREN);
        assert(stop >= 0, "cancel must stop the remote children");
        assert(lines.findIndex((line) => line.includes("'worktree' 'remove'")) > stop);
        assert.isFalse(yield* executor.isLive(ATTEMPT_ID));
        assert.strictEqual(
          ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
          1,
        );
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, working(started))));
    },
  );

  it.effect(
    "records the comments an Attempt posted on its Item when it fails, not when it succeeds",
    () => {
      const recorded: Array<ReadonlyArray<string>> = [];
      const attempt = (parent: StubParent) => {
        const ssh = fakeSsh();
        postSignedComment(ssh);
        const opened: Array<AttemptWindow> = [];
        const sink: AttemptChannel.Sink = {
          append: () => Effect.void,
          salvage: () => Effect.void,
          comments: (comments) =>
            Effect.sync(
              () => void recorded.push(comments.map(({ kind, url }) => kind + " " + url.href)),
            ),
          transcript: Effect.succeed([]),
          windows: aloneOnItem().pipe(
            Effect.map(({ own }) => new AttemptWindows({ own, overlapping: [...opened] })),
          ),
        };
        // The other Attempt opens on the Item while the harvest lists comments, so `SHARED` is
        // excluded only if the harvest reads the windows after GitHub responds.
        ssh.state.onIssueComments = () => void opened.push(OTHER_ATTEMPT);
        return Effect.gen(function* () {
          const executor = yield* Executor;
          const prepared = yield* executor.prepare(onItem);
          return yield* prepared.launch(sink).pipe(Effect.result);
        }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, parent)));
      };
      return Effect.gen(function* () {
        const failed = yield* attempt(fails);
        assert(Result.isFailure(failed) && failed.failure._tag === "InfraFailure");
        assert.deepStrictEqual(recorded, [["issue-comment " + COMMENT]]);

        // A succeeded Attempt's comments are facts in its result, so none are recorded separately.
        const succeeded = yield* attempt(completes);
        assert(Result.isSuccess(succeeded));
        assert.deepStrictEqual(
          succeeded.success.facts.flatMap((fact) =>
            fact._tag === "Comment" ? [fact.url.href] : [],
          ),
          [COMMENT],
        );
        assert.strictEqual(recorded.length, 1);
      });
    },
  );

  it.effect(
    "records only the comments a canceled Attempt posted before the orchestrator ended its window",
    () => {
      const ssh = fakeSsh();
      postSignedComment(ssh);
      const started = Deferred.makeUnsafe<void>();
      const recorded: Array<string> = [];
      // The orchestrator ends the window at 10:05 when the operator cancels, then stops the
      // executor, which harvests comments. `SHARED` (10:07) could belong to a later Attempt of the
      // same Agent, so no window overlaps this one.
      const sink: AttemptChannel.Sink = {
        append: () => Effect.void,
        salvage: () => Effect.void,
        comments: (comments) =>
          Effect.sync(
            () => void recorded.push(...comments.map(({ kind, url }) => `${kind} ${url.href}`)),
          ),
        transcript: Effect.succeed([]),
        windows: Effect.succeed(
          new AttemptWindows({
            own: Option.some(
              new AttemptWindow({
                attemptId: ATTEMPT_ID,
                startedAt: DateTime.makeUnsafe(0),
                endedAt: Option.some(DateTime.makeUnsafe("2026-10-20T10:05:00Z")),
              }),
            ),
            overlapping: [],
          }),
        ),
      };
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(onItem);
        const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* executor.cancel(ATTEMPT_ID);
        const failure = yield* Fiber.join(launch).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AgentFailure");
        assert.deepStrictEqual(recorded, [`issue-comment ${COMMENT}`]);
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, working(started))));
    },
  );

  it.effect("concurrent cancellation waits for salvage and preserves the launch failure", () => {
    const ssh = fakeSsh();
    ssh.state.salvage = "dirty";
    const started = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const recordingSalvage = yield* Deferred.make<void>();
      const finishSalvage = yield* Deferred.make<void>();
      const prepared = yield* executor.prepare(request);
      const launch = yield* prepared
        .launch({
          ...recording().sink,
          comments: () => Effect.void,
          windows: aloneOnItem(),
          salvage: () =>
            Deferred.succeed(recordingSalvage, undefined).pipe(
              Effect.andThen(Deferred.await(finishSalvage)),
            ),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const first = yield* executor.cancel(ATTEMPT_ID).pipe(Effect.forkChild);
      yield* Deferred.await(recordingSalvage);
      const second = yield* executor.cancel(ATTEMPT_ID).pipe(Effect.forkChild);
      // Runs pending fibers while cleanup waits on durable salvage recording.
      yield* TestClock.adjust("0 millis");
      yield* Effect.sync(() => {
        assert.isUndefined(first.pollUnsafe(), "the first cancel must wait for cleanup");
        assert.isUndefined(second.pollUnsafe(), "the repeated cancel must wait for cleanup");
      }).pipe(Effect.ensuring(Deferred.succeed(finishSalvage, undefined)));
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      const failure = yield* Fiber.join(launch).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "AgentFailure");
      assert.strictEqual(failure.message, "The parent task was canceled");
      assert.strictEqual(
        ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
        1,
      );
      yield* executor.cancel(ATTEMPT_ID);
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, working(started))));
  });

  it.effect(
    "a cancel while a failed Attempt's task is still being stopped waits for release and keeps the failure",
    () => {
      const ssh = fakeSsh();
      const stoppingTask = Deferred.makeUnsafe<void>();
      const taskStopped = Deferred.makeUnsafe<void>();
      // Blocks the durable task stop, like a slow durable round trip.
      const holdingTaskStop = (stub: Layer.Layer<AttemptRuntime>) =>
        Layer.effect(
          AttemptRuntime,
          Effect.gen(function* () {
            const stubbed = yield* AttemptRuntime;
            return AttemptRuntime.of({
              ...stubbed,
              cancel: (attemptId) =>
                stubbed
                  .cancel(attemptId)
                  .pipe(
                    Effect.andThen(Deferred.succeed(stoppingTask, undefined)),
                    Effect.andThen(Deferred.await(taskStopped)),
                  ),
            });
          }),
        ).pipe(Layer.provide(stub));
      return Effect.gen(function* () {
        const executor = yield* Executor;
        const prepared = yield* executor.prepare(request);
        const launch = yield* prepared.launch(recording().sink).pipe(Effect.forkChild);
        yield* Deferred.await(stoppingTask);
        // The parent crashed: its run ended and the launch is stopping its durable task.
        const refused = yield* executor
          .intervene(
            ATTEMPT_ID,
            new AttemptChannel.Intervention({
              operator: "Philippe",
              target: new AttemptChannel.ParentTarget(),
              action: new AttemptChannel.Steer({ message: "Use pnpm" }),
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "AgentFailure");
        assert.strictEqual(
          refused.message,
          "This attempt has no live session in this orchestrator",
        );
        const cancel = yield* executor.cancel(ATTEMPT_ID).pipe(Effect.forkChild);
        // A full interrupt grace passes; the cancel must not time out on a stop it didn't start.
        yield* TestClock.adjust("2 seconds");
        yield* Effect.sync(() => {
          assert.isUndefined(cancel.pollUnsafe(), "the cancel must wait for the release");
        }).pipe(Effect.ensuring(Deferred.succeed(taskStopped, undefined)));
        yield* Fiber.join(cancel);
        const failure = yield* Fiber.join(launch).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InfraFailure");
        assert.strictEqual(failure.message, "The parent stopped");
        assert.isFalse(yield* executor.isLive(ATTEMPT_ID));
        assert.strictEqual(
          ssh.state.commands.filter(({ args }) => args.includes("detach")).length,
          1,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(runtime(ssh.layer, fails, new StubStorage(), holdingTaskStop)),
      );
    },
  );

  it.effect("stops a parent that runs past its wall-clock ceiling", () => {
    const ssh = fakeSsh();
    const started = Deferred.makeUnsafe<void>();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(
        new CheckoutRequest({ ...request, maxAttemptMinutes: Option.some(1) }),
      );
      const launch = yield* prepared.launch(recording().sink).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 minute");
      const failure = yield* Fiber.join(launch).pipe(Effect.flip);
      assert(failure._tag === "RunawayFailure");
      assert.strictEqual(failure.ceiling, "wall-clock");
      assert.include(ssh.state.commands.map(remoteLine), KILL_CHILDREN);
      assert.isFalse(yield* executor.isLive(ATTEMPT_ID));
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, working(started))));
  });

  it.effect("delivers operator input to the live parent task", () => {
    const ssh = fakeSsh();
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const { transcript, sink } = recording();
    const parent: StubParent = (context) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(completes(context)),
      );
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const prepared = yield* executor.prepare(request);
      const launch = yield* prepared.launch(sink).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* executor.intervene(
        ATTEMPT_ID,
        new AttemptChannel.Intervention({
          operator: "Philippe",
          target: new AttemptChannel.ParentTarget(),
          action: new AttemptChannel.Steer({ message: "Use pnpm" }),
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(launch);
      assert.deepStrictEqual(
        transcript
          .filter(([, envelope]) => envelope.payload._tag !== "SessionEvent")
          .map(([direction, envelope]) => [direction, envelope.payload._tag]),
        [
          ["outbound", "Started"],
          ["inbound", "Steer"],
          ["outbound", "InterventionApplied"],
          ["outbound", "Final"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, parent)));
  });

  it.effect(
    "reattaches after a restart and takes over the VM checkout with fresh credentials",
    () => {
      const ssh = fakeSsh();
      const storage = new StubStorage();
      return Effect.gen(function* () {
        yield* stopMidAttempt(ssh, storage);
        const lines = ssh.state.commands.map(remoteLine);
        const stop = lines.indexOf(KILL_CHILDREN);
        assert(stop >= 0, "a stopping process still stops the Attempt's remote children");
        assert(
          !lines
            .slice(stop)
            .some((line) => line.includes("'worktree' 'remove'") || line.startsWith("exec 'rm'")),
          "the checkout stays on the VM for the reattachment",
        );

        const { transcript, sink } = recording();
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
          assert.isTrue(yield* executor.isLive(ATTEMPT_ID));
          const before = ssh.state.commands.length;
          const prepared = yield* executor.prepare(
            new CheckoutRequest({ ...request, reattach: true }),
          );
          const issued = ssh.state.commands.slice(before);
          const lines = issued.map(remoteLine);
          for (const fresh of ["'clone'", "'fetch'", "'worktree' 'add'"])
            assert(!lines.some((line) => line.includes(fresh)), `reattach must not run ${fresh}`);
          assert.include(lines, `exec 'test' '-d' '${WORKTREE}'`);
          assert.include(lines, KILL_CHILDREN);
          assert(issued.some(({ args }) => args.includes("attach")));
          assert.strictEqual(prepared.workspace.worktree, WORKTREE);
          const result = yield* prepared.launch(sink);
          assert.strictEqual(result.message, `Completed: ${request.task}`);
          assert(
            transcript.some(
              ([, envelope]) =>
                envelope.payload._tag === "SessionEvent" &&
                envelope.payload.event._tag === "TextOutput" &&
                envelope.payload.event.text === "Resumed after a restart",
            ),
          );
          assert.isFalse(yield* executor.isLive(ATTEMPT_ID));
        }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, completes, storage)));
      });
    },
  );

  it.effect("fails the reattachment and cancels the parent task when its checkout is gone", () => {
    const ssh = fakeSsh();
    const storage = new StubStorage();
    return Effect.gen(function* () {
      yield* stopMidAttempt(ssh, storage);
      ssh.state.worktreeGone = true;
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        yield* executor.preflight(WORKER, [TEST_AGENT.brain], 1);
        const before = ssh.state.commands.length;
        const error = yield* executor
          .prepare(new CheckoutRequest({ ...request, reattach: true }))
          .pipe(Effect.scoped, Effect.flip);
        assert.strictEqual(error._tag, "ExecutorOperationError");
        assert.strictEqual(error.message, "The reattached attempt's checkout no longer exists");
        assert(!ssh.state.commands.slice(before).some(({ args }) => args.includes("attach")));
        assert.isFalse(yield* executor.isLive(ATTEMPT_ID));
      }).pipe(Effect.scoped, Effect.provide(runtime(ssh.layer, completes, storage)));
    });
  });

  it.effect(
    "records the comments of an Attempt whose parent failed before a restart, then salvages its checkout",
    () => {
      const ssh = fakeSsh();
      ssh.state.salvage = "dirty";
      postSignedComment(ssh);
      const storage = new StubStorage();
      return Effect.gen(function* () {
        yield* stopMidAttempt(ssh, storage, onItem);
        const restart = ssh.state.commands.length;
        const recorded: Array<string> = [];
        const salvaged: Array<string> = [];
        // The other Attempt opens on the Item while the recovery lists its comments.
        const opened: Array<AttemptWindow> = [];
        ssh.state.onIssueComments = () => void opened.push(OTHER_ATTEMPT);
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.recover(
            openAttempt,
            {
              salvage: (salvage) => Effect.sync(() => void salvaged.push(salvage._tag)),
              comments: (comments) =>
                Effect.sync(
                  () =>
                    void recorded.push(...comments.map(({ kind, url }) => `${kind} ${url.href}`)),
                ),
              windows: aloneOnItem().pipe(
                Effect.map(({ own }) => new AttemptWindows({ own, overlapping: [...opened] })),
              ),
            },
            Effect.succeed(COMMIT_AUTHOR),
          );
          // The Run closes the Attempt from the stored failure without launching it again.
          const outcome = yield* executor.outcome(ATTEMPT_ID);
          assert(Option.isSome(outcome) && Result.isFailure(outcome.value));
        }).pipe(
          Effect.scoped,
          Effect.provide(runtime(ssh.layer, completes, storage, parentFailed)),
        );
        assert.deepStrictEqual(recorded, [`issue-comment ${COMMENT}`]);
        assert.deepStrictEqual(salvaged, ["Pushed"]);
        const lines = ssh.state.commands.slice(restart).map(remoteLine);
        const harvested = lines.findIndex(
          (line) =>
            line.startsWith(`cd '${WORKTREE}'`) &&
            line.includes("&& exec 'gh' 'api' 'repos/acme/demo/issues/42/comments?"),
        );
        const removed = lines.findIndex((line) => line.includes("'worktree' 'remove'"));
        assert(harvested >= 0, "the comments are harvested in the Attempt's checkout");
        assert(removed > harvested, "the comments are harvested before the checkout is removed");
      });
    },
  );

  it.effect(
    "records no comment for an Attempt whose parent failed before a restart when its checkout is gone",
    () => {
      const ssh = fakeSsh();
      postSignedComment(ssh);
      const storage = new StubStorage();
      const warnings: Array<unknown> = [];
      const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      return Effect.gen(function* () {
        yield* stopMidAttempt(ssh, storage, onItem);
        ssh.state.worktreeGone = true;
        const restart = ssh.state.commands.length;
        const recorded: Array<unknown> = [];
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.recover(
            openAttempt,
            {
              salvage: () => Effect.die("A checkout that is gone has no salvage"),
              comments: (comments) => Effect.sync(() => void recorded.push(...comments)),
              windows: aloneOnItem(),
            },
            Effect.die("A checkout that is gone has no salvage to commit"),
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(runtime(ssh.layer, completes, storage, parentFailed)),
          Effect.provide(Logger.layer([logger])),
        );
        assert.deepStrictEqual(recorded, []);
        const issued = ssh.state.commands.slice(restart);
        assert(!issued.some(({ args }) => args.includes("attach")), "no credential is granted");
        assert(!issued.map(remoteLine).some((line) => line.includes("'gh'")));
        assert(JSON.stringify(warnings).includes("its checkout is gone"));
      });
    },
  );

  it.effect("checks the roster on the VM and refuses login loss before preparation", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.preflight(
        WORKER,
        [TEST_AGENT.brain, new BrainSpec({ ...TEST_AGENT.brain })],
        1,
      );
      assert.strictEqual(
        ssh.state.commands.filter((command) => remoteLine(command) === "exec 'claude' '--version'")
          .length,
        1,
      );
      ssh.state.claudeLoggedIn = false;
      const error = yield* executor.prepare(request).pipe(Effect.scoped, Effect.flip);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.capability, "harness-login");
      assert(!ssh.state.commands.some((command) => command.args.includes("attach")));
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });

  it.effect("refuses a Pi roster brain, whose children cannot run on the VM", () => {
    const ssh = fakeSsh();
    return Effect.gen(function* () {
      const executor = yield* Executor;
      const error = yield* executor
        .preflight(
          WORKER,
          [
            new BrainSpec({
              harness: "pi",
              model: ModelId.make("anthropic/claude"),
              effort: "low",
            }),
          ],
          1,
        )
        .pipe(Effect.flip);
      assert(error._tag === "WorkerCapabilityError");
      assert.strictEqual(error.message, "Pi children run only on local workers");
    }).pipe(Effect.provide(runtime(ssh.layer)));
  });
});

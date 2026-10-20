import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { InfraFailure } from "@usine/core/attempt/failure";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { RunEngine } from "@usine/engine/engine";
import { CheckoutRequest, Executor } from "@usine/executor";
import { layer as localExecutorLayer } from "@usine/executor/local";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { stubAttemptRuntime, StubStorage, worksFor } from "@usine/durable/testing";
import {
  LIVE_TEST_TIMEOUT,
  STATE_POLL_ATTEMPTS,
  TOKEN,
  credentialLayer,
  harnessReady,
  localRuntime,
  makeRemote,
  output,
  run,
  submission,
  testAgent,
  waitFor,
  waitForSalvage,
  waitForStarted,
  withLocalEngine,
} from "./support.ts";

describe("local worker salvage", () => {
  it.live(
    "salvages uncommitted work to the salvage ref when a live Attempt is canceled",
    () =>
      withLocalEngine(
        { attemptRuntime: stubAttemptRuntime(new StubStorage(), worksFor(5_000)) },
        ({ engine, instance, remote }) =>
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const fileSystem = yield* FileSystem.FileSystem;
            const accepted = yield* engine.submit(submission(3));
            assert.strictEqual(accepted._tag, "Claimed");
            if (accepted._tag !== "Claimed") return;
            const running = yield* waitFor(engine, accepted.runId, "Running");
            const attempt = running.attempts[0];
            assert(attempt !== undefined);
            yield* waitForStarted(engine, attempt.id);
            const attemptsDirectory = path.join(instance, ".usine", "workers", "local", "attempts");
            const worktree = path.join(attemptsDirectory, attempt.id.replaceAll("/", "_"));
            yield* fileSystem.writeFileString(path.join(worktree, "progress.md"), "half done\n");
            yield* engine.cancel(accepted.runId);
            yield* waitFor(engine, accepted.runId, "Canceled");
            const salvaged = yield* waitForSalvage(engine, accepted.runId);
            assert(salvaged._tag === "Pushed", "the canceled Attempt recorded no pushed salvage");
            assert.strictEqual(salvaged.ref, `usine/salvage/${accepted.runId}/1`);
            const pushed = (yield* output("git", [
              "--git-dir",
              remote,
              "rev-parse",
              `refs/heads/${salvaged.ref}`,
            ])).trim();
            assert.strictEqual(pushed, salvaged.commit);
            const subject = (yield* output("git", [
              "--git-dir",
              remote,
              "log",
              "-1",
              "--format=%s",
              salvaged.commit,
            ])).trim();
            assert.strictEqual(subject, `wip(usine): salvage attempt ${attempt.id}`);
            const files = (yield* output("git", [
              "--git-dir",
              remote,
              "ls-tree",
              "--name-only",
              salvaged.commit,
            ])).trim();
            assert(files.includes("progress.md"));
            let leftovers = yield* fileSystem.readDirectory(attemptsDirectory);
            for (let poll = 0; leftovers.length > 0 && poll < STATE_POLL_ATTEMPTS; poll += 1) {
              yield* Effect.sleep("10 millis");
              leftovers = yield* fileSystem.readDirectory(attemptsDirectory);
            }
            assert.deepStrictEqual(leftovers, []);
          }),
      ),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "resumes salvage, recovers a failed durable write, and uses the base only for a deleted ref",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-resume-" });
        const remote = yield* makeRemote(root);
        const seed = `${root}/seed`;
        const base = (yield* output("git", ["rev-parse", "HEAD"], seed)).trim();
        yield* fileSystem.writeFileString(`${seed}/progress.md`, "half done\n");
        yield* run("git", ["add", "progress.md"], seed);
        yield* run("git", ["commit", "-m", "wip(usine): salvage attempt r/1"], seed);
        const salvageCommit = CommitSha.make(
          (yield* output("git", ["rev-parse", "HEAD"], seed)).trim(),
        );
        const ref = SalvageRef.make("usine/salvage/r/1");
        yield* run("git", ["push", "origin", `HEAD:refs/heads/${ref}`], seed);
        const runtime = localExecutorLayer({
          instanceDirectory: InstanceDirectory.make(root),
          repositoryUrl: () => remote,
          harnessReadiness: harnessReady,
        }).pipe(
          Layer.provide(credentialLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
        );
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const request = new CheckoutRequest({
            attemptId: AttemptId.make("r/run/2"),
            worker: WorkerName.make("local"),
            repository: RepositoryName.make("acme/demo"),
            loop: LoopName.make("local-worker"),
            permissions: "write",
            revision: RepositoryRevision.make("main"),
            payload: {},
            task: AttemptTask.make("Continue the work"),
            agent: testAgent,
            parentModel: Option.none(),
            maxChildren: ChildSessionBudget.make(4),
            maxAttemptMinutes: Option.none(),
            maxAttemptTokens: Option.none(),
            parentEffort: "high",
            salvageRef: SalvageRef.make("usine/salvage/r/2"),
            resume: Option.some(new SalvagePushed({ ref, commit: salvageCommit })),
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const prepared = yield* executor.prepare(request);
              assert.strictEqual(prepared.workspace.spec.baseCommit, base);
              assert.deepStrictEqual(
                prepared.workspace.spec.resume,
                Option.some(new SalvagePushed({ ref, commit: salvageCommit })),
              );
              assert.strictEqual(
                (yield* output("git", ["rev-parse", "HEAD"], prepared.workspace.worktree)).trim(),
                salvageCommit,
              );
            }),
          );
          const failedRecordRequest = new CheckoutRequest({
            ...request,
            attemptId: AttemptId.make("r/run/4"),
          });
          const retained = yield* Effect.scoped(
            Effect.gen(function* () {
              const prepared = yield* executor.prepare(failedRecordRequest);
              const worktree = prepared.workspace.worktree;
              yield* fileSystem.writeFileString(
                `${worktree}/progress.txt`,
                "persist before removal\n",
              );
              const exit = yield* Effect.exit(
                prepared.launch({
                  append: () =>
                    Effect.fail(
                      new InfraFailure({ message: "channel unavailable", cause: "outage" }),
                    ),
                  comments: () => Effect.void,
                  salvage: () =>
                    Effect.gen(function* () {
                      assert(yield* fileSystem.exists(worktree).pipe(Effect.orDie));
                      return yield* new InfraFailure({
                        message: "salvage database unavailable",
                        cause: "outage",
                      });
                    }),
                }),
              );
              assert(Exit.isFailure(exit));
              assert(Cause.pretty(exit.cause).includes("salvage database unavailable"));
              assert(yield* fileSystem.exists(worktree));
              return worktree;
            }),
          );
          const recorded: Array<SalvagePushed> = [];
          yield* executor.recover(
            {
              attemptId: failedRecordRequest.attemptId,
              worker: request.worker,
              repository: request.repository,
              ref: request.salvageRef,
              permissions: "write",
              succeeded: false,
              open: false,
            },
            (salvage) =>
              Effect.gen(function* () {
                assert(yield* fileSystem.exists(retained));
                assert(salvage._tag === "Pushed");
                recorded.push(salvage);
              }),
          );
          const recovered = recorded[0];
          assert(recovered !== undefined);
          assert.strictEqual(
            (yield* output("git", [
              "--git-dir",
              remote,
              "show",
              `${recovered.commit}:progress.txt`,
            ])).trim(),
            "persist before removal",
          );
          assert(!(yield* fileSystem.exists(retained)));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const prepared = yield* executor.prepare(
                new CheckoutRequest({
                  ...request,
                  attemptId: AttemptId.make("r/run/3"),
                  resume: Option.some(
                    new SalvagePushed({
                      ref: SalvageRef.make("usine/salvage/r/deleted"),
                      commit: salvageCommit,
                    }),
                  ),
                }),
              );
              assert(Option.isNone(prepared.workspace.spec.resume));
              assert.strictEqual(
                (yield* output("git", ["rev-parse", "HEAD"], prepared.workspace.worktree)).trim(),
                base,
              );
            }),
          );
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "starts a retry from the current default branch and applies the previous salvage onto it",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-local-rebase-" });
        const remote = yield* makeRemote(root);
        const seed = `${root}/seed`;
        const git = (args: ReadonlyArray<string>) => run("git", args, seed);
        const head = (cwd: string) =>
          output("git", ["rev-parse", "HEAD"], cwd).pipe(
            Effect.map((sha) => CommitSha.make(sha.trim())),
          );
        const commitFile = (file: string, content: string, message: string) =>
          Effect.gen(function* () {
            yield* fileSystem.writeFileString(`${seed}/${file}`, content);
            yield* git(["add", file]);
            yield* git(["commit", "-m", message]);
            return yield* head(seed);
          });
        const salvage = (number: number, commit: CommitSha) =>
          Effect.gen(function* () {
            const ref = SalvageRef.make(`usine/salvage/r/${number}`);
            yield* git(["push", "origin", `${commit}:refs/heads/${ref}`]);
            return new SalvagePushed({ ref, commit });
          });
        const firstBase = yield* head(seed);
        yield* git(["checkout", "-b", "attempt-1"]);
        const worked = yield* salvage(
          1,
          yield* commitFile("progress.md", "half done\n", "wip(usine): salvage attempt r/1"),
        );
        yield* git(["checkout", "-b", "attempt-2", firstBase]);
        const conflicting = yield* salvage(
          2,
          yield* commitFile("README.md", "# edited by the Attempt\n", "wip(usine): salvage r/2"),
        );
        yield* git(["checkout", "-b", "attempt-3", firstBase]);
        yield* git(["commit", "--allow-empty", "-m", "wip(usine): salvage attempt r/3"]);
        const empty = yield* salvage(3, yield* head(seed));
        // A fix lands on the default branch after the first Attempt started.
        yield* git(["checkout", "main"]);
        const tip = yield* commitFile("README.md", "# fixed on main\n", "fix: unblock the run");
        yield* git(["push", "origin", "main"]);

        const runtime = localExecutorLayer({
          instanceDirectory: InstanceDirectory.make(root),
          repositoryUrl: () => remote,
          harnessReadiness: harnessReady,
        }).pipe(
          Layer.provide(credentialLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
        );
        const request = (number: number, resume: SalvagePushed) =>
          new CheckoutRequest({
            attemptId: AttemptId.make(`r/run/${number}`),
            worker: WorkerName.make("local"),
            repository: RepositoryName.make("acme/demo"),
            loop: LoopName.make("local-worker"),
            permissions: "write",
            revision: RepositoryRevision.make("main"),
            payload: {},
            task: AttemptTask.make("Continue the work"),
            agent: testAgent,
            parentModel: Option.none(),
            maxChildren: ChildSessionBudget.make(4),
            maxAttemptMinutes: Option.none(),
            maxAttemptTokens: Option.none(),
            parentEffort: "high",
            salvageRef: SalvageRef.make(`usine/salvage/r/${number}`),
            resume: Option.some(resume),
          });
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const read = (worktree: string, file: string) =>
            fileSystem.readFileString(`${worktree}/${file}`);

          yield* Effect.scoped(
            Effect.gen(function* () {
              const { spec, worktree } = (yield* executor.prepare(request(4, worked))).workspace;
              assert.strictEqual(spec.baseCommit, tip);
              assert.deepStrictEqual(spec.resume, Option.some(worked));
              assert(Option.isNone(spec.conflictingSalvage));
              assert.strictEqual(
                (yield* output("git", ["rev-parse", "HEAD^"], worktree)).trim(),
                tip,
              );
              assert.strictEqual(yield* read(worktree, "progress.md"), "half done\n");
              assert.strictEqual(yield* read(worktree, "README.md"), "# fixed on main\n");
            }),
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const { spec, worktree } = (yield* executor.prepare(request(5, conflicting)))
                .workspace;
              assert.strictEqual(spec.baseCommit, tip);
              assert(Option.isNone(spec.resume));
              assert.deepStrictEqual(spec.conflictingSalvage, Option.some(conflicting));
              assert.strictEqual(yield* head(worktree), tip);
              assert.strictEqual(yield* read(worktree, "README.md"), "# fixed on main\n");
              assert.strictEqual(
                (yield* output("git", ["--git-dir", remote, "rev-parse", conflicting.ref])).trim(),
                conflicting.commit,
              );
            }),
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const { spec, worktree } = (yield* executor.prepare(request(6, empty))).workspace;
              assert(Option.isNone(spec.resume));
              assert(Option.isNone(spec.conflictingSalvage));
              assert.strictEqual(yield* head(worktree), tip);
            }),
          );
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "restart publishes retained work and records it before releasing the checkout",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-reconcile-" });
        const instance = InstanceDirectory.make(root);
        const remote = yield* makeRemote(root);
        const hook = `${remote}/hooks/pre-receive`;
        // The hook inherits git's environment, so the remote's reply can echo the
        // Attempt token the way a verbose transport error would.
        yield* fileSystem.writeFileString(
          hook,
          '#!/bin/sh\necho "access revoked for $(cat "$USINE_GITHUB_TOKEN_FILE")" >&2\nexit 1\n',
          { mode: 0o755 },
        );
        const storage = new StubStorage();
        const runtime = () =>
          localRuntime(instance, remote, {
            attemptRuntime: stubAttemptRuntime(storage, worksFor(60_000)),
          });
        const saved = yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(submission(1));
          assert(accepted._tag === "Claimed");
          const running = yield* waitFor(engine, accepted.runId, "Running");
          const attempt = running.attempts[0];
          assert(attempt !== undefined);
          const worktree = `${root}/.usine/workers/local/attempts/${attempt.id.replaceAll("/", "_")}`;
          yield* waitForStarted(engine, attempt.id);
          yield* fileSystem.writeFileString(`${worktree}/progress.txt`, "recover this work\n");
          yield* engine.cancel(accepted.runId);
          const salvage = yield* waitForSalvage(engine, accepted.runId);
          assert(salvage._tag === "Retained");
          // The remote's own words reach the record, not only git's exit code,
          // and the token they echoed does not.
          assert.include(salvage.message, "access revoked for [REDACTED]");
          assert.notInclude(salvage.message, TOKEN);
          assert(yield* fileSystem.exists(worktree));
          return { runId: accepted.runId, worktree };
        }).pipe(Effect.provide(runtime()));
        // A second startup during the outage must also retain the only copy, and
        // its reconcile rewrites the record with the reason that push failed too.
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const salvage = (yield* engine.inspect(saved.runId)).attempts[0]?.salvage;
          assert(salvage !== undefined && Option.isSome(salvage));
          assert(salvage.value._tag === "Retained");
          assert.include(salvage.value.message, "access revoked for [REDACTED]");
          assert.notInclude(salvage.value.message, TOKEN);
        }).pipe(Effect.provide(runtime()));
        assert(yield* fileSystem.exists(saved.worktree));
        yield* fileSystem.remove(hook);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const salvage = (yield* engine.inspect(saved.runId)).attempts[0]?.salvage;
          assert(salvage !== undefined && Option.isSome(salvage));
          assert(salvage.value._tag === "Pushed");
          assert.strictEqual(
            (yield* output("git", [
              "--git-dir",
              remote,
              "show",
              `${salvage.value.commit}:progress.txt`,
            ])).trim(),
            "recover this work",
          );
          assert(!(yield* fileSystem.exists(saved.worktree)));
        }).pipe(Effect.provide(runtime()));
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );
});

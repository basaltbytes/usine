// The Node server adapter requires native HTTP server and connection types.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { harnessesLive } from "@usine/agents/harness/node";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AgentFailure, InfraFailure } from "@usine/core/attempt/failure";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { SalvagePushed, SalvageRef } from "@usine/core/attempt/salvage";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName } from "@usine/core/loop";
import { CommitSha, RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { RunEngine } from "@usine/engine/engine";
import { hostLoginLockLayer, CheckoutRequest, Executor } from "@usine/executor";
import { layer as localExecutorLayer } from "@usine/executor/local";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { stubAttemptRuntime, StubStorage, worksFor } from "@usine/durable/testing";
import {
  aloneOnItem,
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
import { runView } from "../../src/operator/projection.ts";
import { testBotAccount } from "../support/github-app.ts";

/** The identity of `testBotAccount` in git's `<name> <email>` form. */
const BOT = "usine-test[bot] <4242+usine-test[bot]@users.noreply.github.com>";

/** Returns the author and committer of `commit`, read in the repository at `cwd`. */
const identityOf = (commit: string, cwd: string) =>
  output("git", ["log", "-1", "--format=%an <%ae>%n%cn <%ce>", commit], cwd).pipe(
    Effect.map((text) => text.trim().split("\n")),
  );

describe("local worker salvage", () => {
  it.live(
    "records a git-receive-pack 403 as the attempt failure and retains its work",
    () =>
      Effect.gen(function* () {
        const requests: Array<string | undefined> = [];
        const githubMessage = "Permission to acme/demo.git denied to usine-test[bot].";
        const server = yield* NodeHttpServer.make(
          () =>
            createServer((request, response) => {
              requests.push(request.url);
              response.writeHead(403, { "content-type": "text/plain" });
              response.end(`${githubMessage} ${TOKEN}`);
            }),
          { host: "127.0.0.1", port: 0 },
        );
        assert(server.address._tag !== "UnixPathAddress");
        const pushUrl = `http://127.0.0.1:${server.address.port}/acme/demo.git`;
        const parent = stubAttemptRuntime(new StubStorage(), ({ request }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${request.cwd}/progress.txt`, "keep this work\n");
            yield* run("git", ["remote", "set-url", "--push", "origin", pushUrl], request.cwd);
          }).pipe(
            Effect.provide(NodeServices.layer),
            Effect.orDie,
            Effect.andThen(AgentFailure.make({ message: "The agent could not finish" })),
          ),
        );
        yield* withLocalEngine({ attemptRuntime: parent }, ({ engine }) =>
          Effect.gen(function* () {
            const accepted = yield* engine.submit(submission(1));
            assert(accepted._tag === "Claimed");
            const snapshot = yield* waitFor(engine, accepted.runId, "Failed");
            assert.lengthOf(snapshot.attempts, 1);
            const attempt = snapshot.attempts[0];
            assert(attempt !== undefined && Option.isSome(attempt.outcome));
            assert(attempt.outcome.value._tag === "Failed");
            const failure = attempt.outcome.value.failure;
            assert(failure._tag === "GitHubPushFailure");
            assert.strictEqual(failure.repository, "acme/demo");
            assert.strictEqual(failure.ref, `refs/heads/usine/salvage/${accepted.runId}/1`);
            assert.include(failure.message, githubMessage);
            assert.notInclude(failure.message, TOKEN);
            assert.include(failure.message, failure.repository);
            assert.include(failure.message, failure.ref);
            assert.include(failure.message, "single-repository installation token");
            assert(Option.isSome(attempt.salvage) && attempt.salvage.value._tag === "Retained");
            assert.deepStrictEqual(attempt.salvage.value.pushFailure, Option.some(failure));
            const fs = yield* FileSystem.FileSystem;
            const contents = yield* fs.readFileString(`${attempt.salvage.value.path}/progress.txt`);
            assert.strictEqual(contents, "keep this work\n");
            const view = runView(snapshot, new Set(), new Map());
            assert.isTrue(view.canResolveFailure);
            const outcome = view.attempts[0]?.outcome;
            assert(outcome?._tag === "Failed" && outcome.failure._tag === "GitHubPushFailure");
            assert.strictEqual(outcome.failure.message, failure.message);
          }),
        );
        assert.include(requests, "/acme/demo.git/info/refs?service=git-receive-pack");
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

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
            const commitIdentity = yield* identityOf(salvaged.commit, remote);
            assert.deepStrictEqual(commitIdentity, [BOT, BOT]);
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
          Layer.provide(harnessesLive),
          Layer.provide(credentialLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(hostLoginLockLayer),
        );
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          const request = CheckoutRequest.make({
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
            resume: Option.some(SalvagePushed.make({ ref, commit: salvageCommit })),
            commitAuthor: testBotAccount,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const prepared = yield* executor.prepare(request);
              assert.strictEqual(prepared.workspace.spec.baseCommit, base);
              assert.deepStrictEqual(
                prepared.workspace.spec.resume,
                Option.some(SalvagePushed.make({ ref, commit: salvageCommit })),
              );
              assert.strictEqual(
                (yield* output("git", ["rev-parse", "HEAD"], prepared.workspace.worktree)).trim(),
                salvageCommit,
              );
            }),
          );
          const failedRecordRequest = CheckoutRequest.make({
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
                      InfraFailure.make({ message: "channel unavailable", cause: "outage" }),
                    ),
                  comments: () => Effect.void,
                  outOfMemory: () => Effect.void,
                  transcript: Effect.succeed([]),
                  windows: aloneOnItem(failedRecordRequest.attemptId),
                  salvage: () =>
                    Effect.gen(function* () {
                      const currentExists = yield* fileSystem.exists(worktree).pipe(Effect.orDie);
                      assert(currentExists);
                      return yield* InfraFailure.make({
                        message: "salvage database unavailable",
                        cause: "outage",
                      });
                    }),
                }),
              );
              assert(Exit.isFailure(exit));
              assert(Cause.pretty(exit.cause).includes("salvage database unavailable"));
              const currentExists = yield* fileSystem.exists(worktree);
              assert(currentExists);
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
              rejected: Option.none(),
            },
            {
              salvage: (salvage) =>
                Effect.gen(function* () {
                  const currentExists = yield* fileSystem.exists(retained);
                  assert(currentExists);
                  assert(salvage._tag === "Pushed");
                  recorded.push(salvage);
                }),
              comments: () => Effect.void,
              windows: aloneOnItem(failedRecordRequest.attemptId),
            },
            Effect.succeed(testBotAccount),
          );
          const recovered = recorded[0];
          assert(recovered !== undefined);
          const commitIdentity = yield* identityOf(recovered.commit, remote);
          assert.deepStrictEqual(commitIdentity, [BOT, BOT]);
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
                CheckoutRequest.make({
                  ...request,
                  attemptId: AttemptId.make("r/run/3"),
                  resume: Option.some(
                    SalvagePushed.make({
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
        const commitFile = (
          file: string,
          content: string,
          message: string,
          ...options: ReadonlyArray<string>
        ) =>
          Effect.gen(function* () {
            yield* fileSystem.writeFileString(`${seed}/${file}`, content);
            yield* git(["add", file]);
            yield* git(["commit", "-m", message, ...options]);
            return yield* head(seed);
          });
        const salvage = (number: number, commit: CommitSha) =>
          Effect.gen(function* () {
            const ref = SalvageRef.make(`usine/salvage/r/${number}`);
            yield* git(["push", "origin", `${commit}:refs/heads/${ref}`]);
            return SalvagePushed.make({ ref, commit });
          });
        const firstBase = yield* head(seed);
        yield* git(["checkout", "-b", "attempt-1"]);
        // Authored by the bot, like a salvage commit, and committed by the seed's identity.
        const currentCommit = yield* commitFile(
          "progress.md",
          "half done\n",
          "wip(usine): salvage attempt r/1",
          `--author=${BOT}`,
        );
        const worked = yield* salvage(1, currentCommit);
        yield* git(["checkout", "-b", "attempt-2", firstBase]);
        const nextCommit = yield* commitFile(
          "README.md",
          "# edited by the Attempt\n",
          "wip(usine): salvage r/2",
        );
        const conflicting = yield* salvage(2, nextCommit);
        yield* git(["checkout", "-b", "attempt-3", firstBase]);
        yield* git(["commit", "--allow-empty", "-m", "wip(usine): salvage attempt r/3"]);
        const updatedCommit = yield* head(seed);
        const empty = yield* salvage(3, updatedCommit);
        // A fix is committed on the default branch after the first Attempt started.
        yield* git(["checkout", "main"]);
        const tip = yield* commitFile("README.md", "# fixed on main\n", "fix: unblock the run");
        yield* git(["push", "origin", "main"]);

        const runtime = localExecutorLayer({
          instanceDirectory: InstanceDirectory.make(root),
          repositoryUrl: () => remote,
          harnessReadiness: harnessReady,
        }).pipe(
          Layer.provide(harnessesLive),
          Layer.provide(credentialLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(hostLoginLockLayer),
        );
        const request = (number: number, resume: SalvagePushed) =>
          CheckoutRequest.make({
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
            commitAuthor: testBotAccount,
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
              const commitIdentity = yield* identityOf("HEAD", worktree);
              assert.deepStrictEqual(commitIdentity, [BOT, BOT]);
              const contents = yield* read(worktree, "progress.md");
              assert.strictEqual(contents, "half done\n");
              const currentContents = yield* read(worktree, "README.md");
              assert.strictEqual(currentContents, "# fixed on main\n");
            }),
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const { spec, worktree } = (yield* executor.prepare(request(5, conflicting)))
                .workspace;
              assert.strictEqual(spec.baseCommit, tip);
              assert(Option.isNone(spec.resume));
              assert.deepStrictEqual(spec.conflictingSalvage, Option.some(conflicting));
              const currentCommit = yield* head(worktree);
              assert.strictEqual(currentCommit, tip);
              const contents = yield* read(worktree, "README.md");
              assert.strictEqual(contents, "# fixed on main\n");
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
              const commit = yield* head(worktree);
              assert.strictEqual(commit, tip);
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
          // The remote's own message is in the record, not only git's exit code, and the token it
          // echoed isn't.
          assert.include(salvage.message, "access revoked for [REDACTED]");
          assert.notInclude(salvage.message, TOKEN);
          const currentExists = yield* fileSystem.exists(worktree);
          assert(currentExists);
          return { runId: accepted.runId, worktree };
        }).pipe(Effect.provide(runtime()));
        // A second startup during the outage must also keep the only copy, and its reconcile
        // updates the record with the reason that push failed too.
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const salvage = (yield* engine.inspect(saved.runId)).attempts[0]?.salvage;
          assert(salvage !== undefined && Option.isSome(salvage));
          assert(salvage.value._tag === "Retained");
          assert.include(salvage.value.message, "access revoked for [REDACTED]");
          assert.notInclude(salvage.value.message, TOKEN);
        }).pipe(Effect.provide(runtime()));
        const currentExists = yield* fileSystem.exists(saved.worktree);
        assert(currentExists);
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
          const commitIdentity = yield* identityOf(salvage.value.commit, remote);
          assert.deepStrictEqual(commitIdentity, [BOT, BOT]);
          assert(!(yield* fileSystem.exists(saved.worktree)));
        }).pipe(Effect.provide(runtime()));
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "restart keeps a checkout whose push GitHub refused for a large file without pushing it again, also after a recovery that couldn't inspect it",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-rejected-" });
        const instance = InstanceDirectory.make(root);
        const remote = yield* makeRemote(root);
        const refusals = `${root}/refusals`;
        // GitHub's pre-receive hook refuses every push of a commit with a file over 100 MB.
        yield* fileSystem.writeFileString(
          `${remote}/hooks/pre-receive`,
          `#!/bin/sh\necho refused >> '${refusals}'\necho "error: GH001: Large files detected." >&2\nexit 1\n`,
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
          assert(salvage._tag === "Rejected");
          assert.include(salvage.message, "GH001: Large files detected.");
          return { runId: accepted.runId, worktree, salvage };
        }).pipe(Effect.provide(runtime()));
        const restart = () =>
          Effect.gen(function* () {
            const engine = yield* RunEngine;
            const salvage = (yield* engine.inspect(saved.runId)).attempts[0]?.salvage;
            assert.deepStrictEqual(salvage, Option.some(saved.salvage));
          }).pipe(Effect.provide(runtime()));
        // A worktree whose git directory is gone fails the recovery's inspection.
        const gitFile = `${saved.worktree}/.git`;
        const gitLink = yield* fileSystem.readFileString(gitFile);
        yield* fileSystem.writeFileString(gitFile, `gitdir: ${root}/missing-git-directory\n`);
        yield* restart();
        yield* fileSystem.writeFileString(gitFile, gitLink);
        yield* restart();
        const contents = yield* fileSystem.readFileString(refusals);
        assert.strictEqual(contents, "refused\n");
        const currentExists = yield* fileSystem.exists(saved.worktree);
        assert(currentExists);
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "pushes the rest of a canceled Attempt's work and keeps the checkout of a file larger than GitHub accepts, also after a restart",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-large-file-" });
        const instance = InstanceDirectory.make(root);
        const remote = yield* makeRemote(root);
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
          yield* fileSystem.writeFileString(`${worktree}/dataset.csv`, "");
          yield* fileSystem.truncate(`${worktree}/dataset.csv`, 100 * 1024 * 1024 + 1);
          yield* engine.cancel(accepted.runId);
          const salvage = yield* waitForSalvage(engine, accepted.runId);
          assert(salvage._tag === "PartlyPushed");
          assert.include(salvage.message, "dataset.csv (100.0 MiB)");
          return { runId: accepted.runId, worktree, salvage };
        }).pipe(Effect.provide(runtime()));
        const currentExists = yield* fileSystem.exists(`${saved.worktree}/dataset.csv`);
        assert(currentExists);
        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const salvage = (yield* engine.inspect(saved.runId)).attempts[0]?.salvage;
          assert.deepStrictEqual(salvage, Option.some(saved.salvage));
        }).pipe(Effect.provide(runtime()));
        const nextExists = yield* fileSystem.exists(`${saved.worktree}/dataset.csv`);
        assert(nextExists);
        assert.strictEqual(
          (yield* output("git", [
            "--git-dir",
            remote,
            "ls-tree",
            "--name-only",
            saved.salvage.commit,
          ])).trim(),
          "README.md\nprogress.txt",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );
});

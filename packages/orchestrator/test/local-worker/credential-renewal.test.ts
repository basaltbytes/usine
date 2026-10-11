import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { InstanceDirectory } from "@usine/core/instance";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { CheckoutRequest, CredentialProvider, Executor, WorkerCredential } from "@usine/executor";
import { layer as localExecutorLayer } from "@usine/executor/local";
import {
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Scope,
  Exit,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { stubAttemptRuntime, StubStorage } from "@usine/durable/testing";
import { LIVE_TEST_TIMEOUT, harnessReady, makeRemote, testAgent } from "./support.ts";

it.effect(
  "renewed Git and gh credentials reach existing child environments and the salvage push after three hours",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-renewal-" });
      const remote = yield* makeRemote(root);
      let minted = 0;
      const credentials = Layer.succeed(CredentialProvider)({
        issue: () =>
          Effect.gen(function* () {
            minted += 1;
            return new WorkerCredential({
              value: Redacted.make(`test-token-${minted}`),
              expiresAt: DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 3_600_000),
            });
          }),
      });
      let environment: ChildProcess.CommandOptions["env"] = {};
      let pushToken: string | undefined;
      const capturing = ChildProcessSpawner.make(
        Effect.fn("test.captureEnvironment")(function* (command) {
          if (command._tag === "StandardCommand" && command.command === "git") {
            environment = { ...command.options.env };
            // The token file is removed with the Attempt scope; read it while the push runs.
            const tokenFile = command.options.env?.USINE_GITHUB_TOKEN_FILE;
            if (command.args.includes("push") && tokenFile !== undefined)
              pushToken = yield* fs.readFileString(tokenFile);
          }
          return yield* spawner.spawn(command);
        }),
      );
      const runtime = localExecutorLayer({
        instanceDirectory: InstanceDirectory.make(root),
        repositoryUrl: () => remote,
        harnessReadiness: harnessReady,
      }).pipe(
        Layer.provide(credentials),
        Layer.provide(stubAttemptRuntime(new StubStorage())),
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, capturing)),
      );
      yield* Effect.gen(function* () {
        const executor = yield* Executor;
        const scope = yield* Scope.make();
        const prepared = yield* executor
          .prepare(
            new CheckoutRequest({
              attemptId: AttemptId.make("renew/work/1"),
              worker: WorkerName.make("local"),
              repository: RepositoryName.make("acme/demo"),
              revision: RepositoryRevision.make("main"),
              payload: {},
              task: AttemptTask.make("Work"),
              agent: testAgent,
              parentModel: Option.none(),
              parentEffort: "high",
              maxChildren: ChildSessionBudget.make(4),
              maxAttemptMinutes: Option.none(),
              maxAttemptTokens: Option.none(),
              salvageRef: SalvageRef.make("usine/salvage/renew/1"),
              resume: Option.none(),
            }),
          )
          .pipe(Scope.provide(scope));
        // Keep exactly the environment inherited at preparation time.
        const inherited = { ...environment };
        assert.strictEqual(minted, 1);
        const configuration = inherited.GH_CONFIG_DIR;
        assert(configuration !== undefined);
        for (let hour = 1; hour <= 3; hour += 1) {
          yield* TestClock.adjust("55 minutes");
          // Real filesystem promises are suspended fibers to TestClock: wait
          // for publication before advancing the next interval.
          while (
            !(yield* fs.readFileString(`${configuration}/hosts.yml`)).includes(
              `test-token-${hour + 1}`,
            )
          )
            yield* Effect.yieldNow;
          yield* TestClock.adjust("5 minutes");
        }
        assert.strictEqual(minted, 4);
        const credential = yield* spawner.string(
          ChildProcess.make("git", ["credential", "fill"], {
            env: inherited,
            extendEnv: false,
            cwd: prepared.workspace.worktree,
            stdin: Stream.make(new TextEncoder().encode("protocol=https\nhost=github.com\n\n")),
          }),
        );
        assert(credential.includes(`password=test-token-${minted}`));
        const ghToken = yield* spawner.string(
          ChildProcess.make("gh", ["auth", "token", "--hostname", "github.com"], {
            env: inherited,
            extendEnv: false,
          }),
        );
        assert.strictEqual(ghToken.trim(), `test-token-${minted}`);
        yield* fs.writeFileString(`${prepared.workspace.worktree}/progress.md`, "half done\n");
        yield* Scope.close(scope, Exit.fail("the Attempt ended without success"));
        assert.strictEqual(pushToken, `test-token-${minted}`);
        const salvaged = yield* spawner.string(
          ChildProcess.make("git", [
            "--git-dir",
            remote,
            "ls-tree",
            "--name-only",
            "usine/salvage/renew/1",
          ]),
        );
        assert(salvaged.includes("progress.md"));
        assert(!(yield* fs.exists(configuration)));
        const releasedCount = minted;
        yield* TestClock.adjust("2 hours");
        assert.strictEqual(minted, releasedCount);
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(NodeServices.layer)),
  LIVE_TEST_TIMEOUT,
);

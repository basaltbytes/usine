import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptId, AttemptTask } from "@usine/core/attempt";
import { AgentFailure } from "@usine/core/attempt/failure";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { InstanceDirectory } from "@usine/core/instance";
import { LoopName, type LoopPermissions } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision } from "@usine/core/repository";
import { WorkerName } from "@usine/core/worker";
import { Submission } from "@usine/engine/engine";
import {
  completes,
  stubAttemptRuntime,
  type StubParent,
  StubStorage,
} from "@usine/durable/testing";
import {
  claudeLoginLockLayer,
  CheckoutRequest,
  CredentialProvider,
  Executor,
} from "@usine/executor";
import { layer as localExecutorLayer } from "@usine/executor/local";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  aloneOnItem,
  LIVE_TEST_TIMEOUT,
  TOKEN,
  harnessReady,
  makeRemote,
  output,
  submission,
  testAgent,
  waitFor,
  withLocalEngine,
  workerCredential,
} from "./support.ts";
import { testBotAccount } from "../support/github-app.ts";

/** What the scripted parent observed in the Attempt's checkout. */
interface Observed {
  status?: string;
  push?: string;
}

describe("local worker Loop permissions", () => {
  it.live(
    "gives a read Loop's Attempt a read token and a pre-push hook that explains the refused push, and keeps no salvage",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-permissions-" });
        const remote = yield* makeRemote(root);
        const issued: Array<LoopPermissions> = [];
        const credentials = Layer.succeed(CredentialProvider)({
          issue: (_repository, _attemptId, permissions) =>
            Effect.sync(() => {
              issued.push(permissions);
              return workerCredential(Redacted.make(TOKEN));
            }),
        });
        const observed = new Map<LoopPermissions, Observed>();
        // Runs a shell line in the checkout with the Attempt's environment, as a child does.
        const shell = (cwd: string, environment: Record<string, string>, line: string) =>
          spawner
            .string(
              ChildProcess.make("sh", ["-c", `${line} 2>&1; echo "exit=$?"`], {
                cwd,
                env: environment,
                extendEnv: false,
              }),
            )
            .pipe(Effect.orDie);
        // Commits a change and pushes it to the pull request branch, as the reviewer of #226 did.
        const parent: StubParent = ({ request }) =>
          Effect.gen(function* () {
            const permissions = request.spec.attemptId.endsWith("read") ? "read" : "write";
            const status = yield* shell(request.cwd, request.environment, "git status --porcelain");
            // The message still shows when the repository sets its own hooks directory, as husky does.
            yield* shell(request.cwd, request.environment, "git config core.hooksPath .husky");
            const push = yield* shell(
              request.cwd,
              request.environment,
              [
                "echo fix > fix.md",
                "git add fix.md",
                "git -c user.name=Reviewer -c user.email=reviewer@example.invalid commit -q -m fix",
                `git push origin HEAD:refs/heads/fix-${permissions}`,
              ].join(" && "),
            );
            observed.set(permissions, { status, push });
            return yield* new AgentFailure({ message: "The review stopped after its push" });
          });
        const runtime = localExecutorLayer({
          instanceDirectory: InstanceDirectory.make(root),
          repositoryUrl: () => remote,
          harnessReadiness: harnessReady,
        }).pipe(
          Layer.provide(credentials),
          Layer.provide(stubAttemptRuntime(new StubStorage(), parent)),
          Layer.provide(claudeLoginLockLayer),
        );
        const request = (permissions: LoopPermissions) =>
          new CheckoutRequest({
            attemptId: AttemptId.make(`review/run/${permissions}`),
            worker: WorkerName.make("local"),
            repository: RepositoryName.make("acme/demo"),
            loop: LoopName.make("review-pr"),
            permissions,
            revision: RepositoryRevision.make("main"),
            payload: {},
            task: AttemptTask.make("Review the pull request"),
            agent: testAgent,
            parentModel: Option.none(),
            maxChildren: ChildSessionBudget.make(4),
            maxAttemptMinutes: Option.none(),
            maxAttemptTokens: Option.none(),
            parentEffort: "high",
            salvageRef: SalvageRef.make(`usine/salvage/review/${permissions}`),
            resume: Option.none(),
            commitAuthor: testBotAccount,
          });
        const remoteBranches = () =>
          output("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"]);

        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          for (const permissions of ["read", "write"] as const) {
            const worktree = yield* Effect.scoped(
              Effect.gen(function* () {
                const prepared = yield* executor.prepare(request(permissions));
                const exit = yield* Effect.exit(
                  prepared.launch({
                    append: () => Effect.void,
                    salvage: () => Effect.void,
                    comments: () => Effect.void,
                    outOfMemory: () => Effect.void,
                    transcript: Effect.succeed([]),
                    windows: aloneOnItem(request(permissions).attemptId),
                  }),
                );
                assert(Exit.isFailure(exit));
                return prepared.workspace.worktree;
              }),
            );
            assert(!(yield* fileSystem.exists(worktree)), `the ${permissions} checkout is removed`);
          }
        }).pipe(Effect.provide(runtime));

        assert.deepStrictEqual(issued, ["read", "write"]);
        const read = observed.get("read");
        const write = observed.get("write");
        assert(read !== undefined && write !== undefined);
        // The hook is outside the working tree, so nothing new shows in the checkout.
        assert.strictEqual(read.status, "exit=0\n");
        assert.include(
          read.push,
          "usine refused this push: the Loop review-pr has permissions: read, so its Attempts cannot push to the repository.",
        );
        assert.notInclude(read.push, "exit=0");
        assert.include(write.push, "exit=0");
        const branches = yield* remoteBranches();
        assert.notInclude(branches, "refs/heads/fix-read");
        assert.include(branches, "refs/heads/fix-write");
        // A read Attempt that ends without success keeps no salvage; a write one pushes it.
        assert.notInclude(branches, "usine/salvage/review/read");
        assert.include(branches, "usine/salvage/review/write");
      }).pipe(Effect.provide(NodeServices.layer)),
    LIVE_TEST_TIMEOUT,
  );

  it.live(
    "mints a read Run's token at its Event's permission level and passes no ambient credential to its Attempt",
    () => {
      const ambient = "ghp_ambient-operator-token";
      const issued: Array<LoopPermissions> = [];
      const environments: Array<Record<string, string>> = [];
      const credentials = Layer.succeed(CredentialProvider)({
        issue: (_repository, _attemptId, permissions) =>
          Effect.sync(() => {
            issued.push(permissions);
            return workerCredential(Redacted.make(TOKEN));
          }),
      });
      const attemptRuntime = stubAttemptRuntime(new StubStorage(), (context) =>
        Effect.sync(() => environments.push(context.request.environment)).pipe(
          Effect.andThen(completes(context)),
        ),
      );
      // The orchestrator's own environment contains the operator's GitHub tokens.
      const orchestratorEnvironment = ConfigProvider.fromEnv({
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).flatMap(([name, value]) =>
              value === undefined ? [] : [[name, value]],
            ),
          ),
          GH_TOKEN: ambient,
          GITHUB_TOKEN: ambient,
          GH_ENTERPRISE_TOKEN: ambient,
        },
      });
      return withLocalEngine({ credentials, attemptRuntime }, ({ engine }) =>
        Effect.gen(function* () {
          const accepted = yield* engine.submit(
            new Submission({ ...submission(8), permissions: "read" }),
          );
          assert(accepted._tag === "Claimed");
          yield* waitFor(engine, accepted.runId, "Succeeded");
          assert(issued.length > 0);
          assert.deepStrictEqual(new Set(issued), new Set(["read"]));

          const [environment] = environments;
          assert(environment !== undefined);
          assert.notInclude(JSON.stringify(environment), ambient);
          assert.deepStrictEqual(
            Object.keys(environment).filter((name) => /TOKEN|CREDENTIAL|ASKPASS/u.test(name)),
            ["USINE_GITHUB_TOKEN_FILE"],
          );
          // git's credential helpers are reset, then only the executor's reads the Attempt's token file.
          assert.strictEqual(environment.GIT_CONFIG_COUNT, "3");
          assert.deepStrictEqual(
            [0, 1, 2].map((index) => environment[`GIT_CONFIG_KEY_${index}`]),
            ["credential.helper", "credential.helper", "core.hooksPath"],
          );
          assert.strictEqual(environment.GIT_CONFIG_VALUE_0, "");
          assert.include(environment.GIT_CONFIG_VALUE_1, "USINE_GITHUB_TOKEN_FILE");
        }),
      ).pipe(Effect.provide(ConfigProvider.layer(orchestratorEnvironment)));
    },
    LIVE_TEST_TIMEOUT,
  );
});

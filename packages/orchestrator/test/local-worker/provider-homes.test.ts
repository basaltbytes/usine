import { harnessesLive } from "@usine/agents/harness/node";
import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ChildSessionBudget } from "@usine/core/agent/session";
import { AttemptId } from "@usine/core/attempt";
import { SalvageRef } from "@usine/core/attempt/salvage";
import { InstanceDirectory } from "@usine/core/instance";
import { WorkerName } from "@usine/core/worker";
import { completes, stubAttemptRuntime, StubStorage } from "@usine/durable/testing";
import { hostLoginLockLayer, CheckoutRequest, Executor } from "@usine/executor";
import { layer as localExecutorLayer } from "@usine/executor/local";
import { Config, ConfigProvider, Effect, FileSystem, Layer, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { testBotAccount } from "../support/github-app.ts";
import {
  aloneOnItem,
  credentialLayer,
  LIVE_TEST_TIMEOUT,
  makeRemote,
  submission,
} from "./support.ts";

it.live(
  "reads custom credential homes in local preflight and attempt children",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const runnerPath = yield* Config.String("PATH").pipe(Effect.orDie);
        const root = yield* fs.makeTempDirectoryScoped();
        const remote = yield* makeRemote(root);
        const claudeHome = `${root}/claude login`;
        const codexHome = `${root}/codex login`;
        yield* fs.makeDirectory(claudeHome);
        yield* fs.makeDirectory(codexHome);
        yield* fs.writeFileString(
          `${claudeHome}/settings.json`,
          '{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"claude-fixture"}}',
        );
        yield* fs.writeFileString(`${codexHome}/auth.json`, '{"OPENAI_API_KEY":"codex-fixture"}');
        yield* fs.writeFileString(
          `${root}/claude`,
          `#!/bin/sh
test -f "$CLAUDE_CONFIG_DIR/settings.json" || exit 1
test -f "$CODEX_HOME/auth.json" || exit 1
if [ "$1" = '--version' ]; then
  printf '%s\\n' '2.1.311 (Claude Code)'
else
  printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
fi
`,
          { mode: 0o700 },
        );
        let childStatus = "";
        const runtime = localExecutorLayer({
          instanceDirectory: InstanceDirectory.make(root),
          repositoryUrl: () => remote,
        }).pipe(
          Layer.provide(credentialLayer),
          Layer.provide(harnessesLive),
          Layer.provide(hostLoginLockLayer),
          Layer.provide(
            stubAttemptRuntime(new StubStorage(), (context) =>
              Effect.gen(function* () {
                childStatus = yield* spawner
                  .string(
                    ChildProcess.make("claude", ["auth", "status", "--json"], {
                      cwd: context.request.cwd,
                      env: context.request.environment,
                      extendEnv: false,
                    }),
                  )
                  .pipe(Effect.orDie);
                return yield* completes(context);
              }),
            ),
          ),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  HOME: root,
                  PATH: `${root}:${runnerPath}`,
                  CLAUDE_CONFIG_DIR: claudeHome,
                  CODEX_HOME: codexHome,
                },
              }),
            ),
          ),
        );
        const selected = submission(1);
        const request = CheckoutRequest.make({
          requiresCi: false,
          attemptId: AttemptId.make("provider-homes/execute/1"),
          worker: WorkerName.make("local"),
          repository: selected.repository,
          loop: selected.loop,
          permissions: "read",
          revision: selected.revision,
          payload: {},
          task: selected.task,
          agent: selected.agent,
          parentModel: Option.none(),
          maxChildren: ChildSessionBudget.make(1),
          maxAttemptMinutes: Option.none(),
          maxAttemptTokens: Option.none(),
          parentEffort: "high",
          salvageRef: SalvageRef.make("usine/salvage/provider-homes/1"),
          resume: Option.none(),
          commitAuthor: testBotAccount,
        });
        yield* Effect.gen(function* () {
          const executor = yield* Executor;
          yield* executor.preflight(request.worker, [selected.agent.brain], 1);
          const prepared = yield* executor.prepare(request);
          yield* prepared.launch({
            append: () => Effect.void,
            salvage: () => Effect.void,
            comments: () => Effect.void,
            outOfMemory: () => Effect.void,
            transcript: Effect.succeed([]),
            windows: aloneOnItem(request.attemptId),
          });
        }).pipe(Effect.provide(runtime));
        assert.include(childStatus, '"loggedIn":true');
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  LIVE_TEST_TIMEOUT,
);

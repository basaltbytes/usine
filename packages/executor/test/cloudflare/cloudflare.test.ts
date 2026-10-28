import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { RemoteShell, sshArguments } from "@usine/agents/child-host";
import { BrainSpec, ModelId } from "@usine/core/agent/brain";
import { Agent } from "@usine/core/agent";
import type { AttemptSalvage } from "@usine/core/attempt/salvage";
import { InfraFailure } from "@usine/core/attempt/failure";
import { CloudflareImageName, WorkerName } from "@usine/core/worker";
import { AttemptRuntime, type AttemptRequest } from "@usine/durable/attempt-runtime";
import {
  completes,
  type StubParent,
  StubStorage,
  stubAttemptRuntime,
} from "@usine/durable/testing";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Redacted, Ref, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { layer as cloudflareLayer } from "../../src/cloudflare/cloudflare.ts";
import type { CloudflareProviderKey } from "../../src/cloudflare/model.ts";
import { SHELL_ENVIRONMENT } from "../../src/cloudflare/shell/environment.ts";
import {
  CheckoutRequest,
  claudeLoginLockLayer,
  CredentialProvider,
  CredentialUnavailableError,
  Executor,
  WorkerCapabilityError,
} from "../../src/executor.ts";
import { keptCheckoutRecovery } from "../../src/provision.ts";
import {
  aloneOnItem,
  COMMIT_AUTHOR,
  mintingProvider,
  request as sshRequest,
  TOKEN_PREFIX,
} from "../ssh/support.ts";
import {
  ACCESS_CLIENT_ID,
  ACCESS_CLIENT_SECRET,
  type FakeSandbox,
  fakeWorker,
} from "./fake-worker.ts";

const WORKER = WorkerName.make("cf-one");
const INSTANCE = "github-app-1";
const OWNER = `${INSTANCE}.${WORKER}`;
const SANDBOX = `${OWNER}.remote-run_execute_1`;
const WORKTREE = "/home/usine/workspace/attempts/remote-run_execute_1";
const SHELL = fileURLToPath(new URL("../../src/cloudflare/shell/shell.ts", import.meta.url));
const ANTHROPIC: CloudflareProviderKey = {
  provider: "anthropic",
  apiKey: Redacted.make("sk-ant-test-key"),
};
const OPENAI: CloudflareProviderKey = {
  provider: "openai",
  apiKey: Redacted.make("sk-openai-test-key"),
};

const request = new CheckoutRequest({ ...sshRequest, worker: WORKER });

/** A credential provider that can't reach GitHub, so it issues no token. */
const unreachableGitHub: ReturnType<typeof mintingProvider> = {
  minted: [],
  permissions: [],
  layer: Layer.succeed(CredentialProvider)({
    issue: (repository) =>
      Effect.fail(
        new CredentialUnavailableError({
          repository,
          reason: "unreachable",
          message: "GitHub didn't answer the installation token request",
          cause: new Error("ETIMEDOUT"),
        }),
      ),
  }),
};

const sink = {
  append: () => Effect.void,
  salvage: () => Effect.void,
  comments: () => Effect.void,
  outOfMemory: () => Effect.void,
  transcript: Effect.succeed([]),
  windows: aloneOnItem(),
};

const brain = (harness: "claude" | "codex" | "pi") =>
  new Agent({
    ...request.agent,
    brain: new BrainSpec({ harness, model: ModelId.make("model"), effort: "high" }),
  });

const executor = (
  worker: { readonly url: URL },
  credentials: ReturnType<typeof mintingProvider>,
  parent: StubParent = completes,
  storage: StubStorage = new StubStorage(),
  providers: ReadonlyArray<CloudflareProviderKey> = [ANTHROPIC],
  accessClientSecret = ACCESS_CLIENT_SECRET,
  runtime = stubAttemptRuntime(storage, parent),
) =>
  cloudflareLayer({
    workers: [
      {
        name: WORKER,
        workerUrl: worker.url,
        accessClientId: Redacted.make(ACCESS_CLIENT_ID),
        accessClientSecret: Redacted.make(accessClientSecret),
        image: CloudflareImageName.make("usine"),
        instanceType: "standard-4",
        providers,
      },
    ],
    instance: INSTANCE,
    shell: { command: process.execPath, args: ["--no-warnings", SHELL] },
    interruptGrace: "2 seconds",
    drainPollInterval: "100 millis",
  }).pipe(
    Layer.provide(credentials.layer),
    Layer.provide(runtime),
    Layer.provide(claudeLoginLockLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeServices.layer),
  );

const runningSandbox = (
  name: string,
  attempt: string,
  paths: ReadonlyArray<string> = [],
): FakeSandbox => ({
  name,
  owner: OWNER,
  attempt,
  running: true,
  held: false,
  draining: false,
  github: [],
  providers: [],
  issued: [],
  paths: new Set(paths),
  commands: [],
  stops: 0,
});

/** A parent that runs `cat` in the sandbox through its host, with `input` on stdin, and records the output. */
const echoingParent =
  (input: string, output: Array<string>, seen: Array<AttemptRequest>): StubParent =>
  (context) =>
    Effect.gen(function* () {
      seen.push(context.request);
      const host = context.request.host;
      assert(host instanceof RemoteShell);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          host.ssh.command,
          sshArguments(host, {
            cwd: context.request.cwd,
            environment: context.request.environment,
            command: "cat",
            args: [],
          }),
          {
            env: { ...host.sshEnvironment },
            extendEnv: false,
            stdin: Stream.make(new TextEncoder().encode(input)),
          },
        ),
      );
      output.push(yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString));
      return yield* completes(context);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.orDie);

describe("cloudflare Worker", () => {
  it.live(
    "runs an Attempt in its own sandbox, with credentials only in the Worker, then destroys it",
    () =>
      Effect.gen(function* () {
        const worker = yield* fakeWorker;
        const credentials = mintingProvider();
        const output: Array<string> = [];
        const seen: Array<AttemptRequest> = [];
        const sandboxes: Array<FakeSandbox> = [];
        yield* Effect.gen(function* () {
          const cloudflare = yield* Executor;
          assert.strictEqual(cloudflare.kind, "cloudflare");
          yield* cloudflare.preflight(WORKER, [request.agent.brain], 2);
          const prepared = yield* cloudflare.prepare(request);
          assert.strictEqual(prepared.workspace.worktree, WORKTREE);
          const sandbox = worker.state.sandboxes.get(SANDBOX);
          assert(sandbox !== undefined);
          sandboxes.push(sandbox);
          // The sandbox starts without credentials; the token comes after the harness check.
          assert.deepStrictEqual(sandbox.github, [null, `${TOKEN_PREFIX}1`]);
          yield* prepared.launch(sink);
          assert.deepStrictEqual(output, ["hello from the parent"]);
          assert.strictEqual(sandbox.stops, 1);
          assert.isTrue(
            sandbox.commands.some(
              (line) =>
                line.includes("'clone'") && line.includes("'https://github.com/acme/demo.git'"),
            ),
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            executor(worker, credentials, echoingParent("hello from the parent", output, seen)),
          ),
        );

        assert.deepStrictEqual(
          worker.state.requests.filter((line) => line.startsWith("DELETE")),
          [`DELETE /v1/sandboxes/${OWNER}.preflight`, `DELETE /v1/sandboxes/${SANDBOX}`],
        );
        assert.strictEqual(worker.state.sandboxes.size, 0);
        // The credentials are revoked before the destroy, so a sandbox whose destroy fails holds none.
        const [sandbox] = sandboxes;
        assert.deepStrictEqual(sandbox?.github, [null, `${TOKEN_PREFIX}1`, null]);
        assert.isBelow(
          worker.state.requests.lastIndexOf(`PUT /v1/sandboxes/${SANDBOX}/credentials`),
          worker.state.requests.indexOf(`DELETE /v1/sandboxes/${SANDBOX}`),
        );
        const [given] = seen;
        assert(given !== undefined && given.host instanceof RemoteShell);
        assert.strictEqual(given.host.destination, SANDBOX);
        assert.strictEqual(
          given.host.sshEnvironment[SHELL_ENVIRONMENT.accessClientSecret],
          ACCESS_CLIENT_SECRET,
        );
        assert.strictEqual(
          given.environment["ANTHROPIC_BASE_URL"],
          "http://anthropic.usine.internal",
        );
        assert.strictEqual(
          given.environment["SSL_CERT_FILE"],
          "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
        );
        assert.isTrue(Option.contains(yield* given.gatewayCredential, "api-key"));
        assert.notInclude(JSON.stringify(given.environment), TOKEN_PREFIX);
        assert.notInclude(JSON.stringify(given.environment), "sk-ant-test-key");
        assert.notInclude(JSON.stringify([...worker.state.sandboxes.values()]), "sk-ant");
      }).pipe(Effect.scoped),
  );

  it.live("stops a canceled Attempt's commands and destroys its sandbox", () =>
    Effect.gen(function* () {
      const worker = yield* fakeWorker;
      const working = yield* Deferred.make<void>();
      const parent: StubParent = () =>
        Deferred.succeed(working, undefined).pipe(Effect.andThen(Effect.never));
      yield* Effect.gen(function* () {
        const cloudflare = yield* Executor;
        const prepared = yield* cloudflare.prepare(request);
        const running = yield* Effect.forkChild(prepared.launch(sink));
        yield* Deferred.await(working);
        yield* cloudflare.cancel(request.attemptId, "cancel");
        const exit = yield* Fiber.await(running);
        assert.isTrue(Exit.isFailure(exit));
      }).pipe(Effect.scoped, Effect.provide(executor(worker, mintingProvider(), parent)));

      assert.isFalse(worker.state.sandboxes.has(SANDBOX));
      const stopsBeforeDelete = worker.state.requests.indexOf(`POST /v1/sandboxes/${SANDBOX}/stop`);
      assert.isTrue(stopsBeforeDelete >= 0);
      assert.isTrue(
        stopsBeforeDelete < worker.state.requests.indexOf(`DELETE /v1/sandboxes/${SANDBOX}`),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps the sandbox for a reattachment, revokes its token, and reattaches after a restart",
    () =>
      Effect.gen(function* () {
        const worker = yield* fakeWorker;
        const storage = new StubStorage();
        const credentials = mintingProvider();
        const working = yield* Deferred.make<void>();
        const blocks: StubParent = () =>
          Deferred.succeed(working, undefined).pipe(Effect.andThen(Effect.never));
        yield* Effect.gen(function* () {
          const cloudflare = yield* Executor;
          const prepared = yield* cloudflare.prepare(request);
          const running = yield* Effect.forkChild(prepared.launch(sink));
          yield* Deferred.await(working);
          // The orchestrator stops: the launch is interrupted without a stop.
          yield* Fiber.interrupt(running);
        }).pipe(Effect.scoped, Effect.provide(executor(worker, credentials, blocks, storage)));

        const kept = worker.state.sandboxes.get(SANDBOX);
        assert(kept !== undefined);
        assert.deepStrictEqual(kept.github, [null, `${TOKEN_PREFIX}1`, null]);
        // The revocation also removes the provider keys, and the hold keeps the checkout.
        assert.deepStrictEqual(kept.providers, [0, 1, 0]);
        assert.isTrue(kept.held);
        const createsBefore = worker.state.requests.filter(
          (line) => line === `PUT /v1/sandboxes/${SANDBOX}`,
        ).length;

        yield* Effect.gen(function* () {
          const cloudflare = yield* Executor;
          assert.isTrue(yield* cloudflare.isLive(request.attemptId));
          const prepared = yield* cloudflare.prepare(
            new CheckoutRequest({ ...request, reattach: true }),
          );
          yield* prepared.launch(sink);
        }).pipe(Effect.scoped, Effect.provide(executor(worker, credentials, completes, storage)));

        assert.strictEqual(
          worker.state.requests.filter((line) => line === `PUT /v1/sandboxes/${SANDBOX}`).length,
          createsBefore,
        );
        assert.deepStrictEqual(kept.github.slice(0, 4), [
          null,
          `${TOKEN_PREFIX}1`,
          null,
          `${TOKEN_PREFIX}2`,
        ]);
        // Each change is issued after the one before, through the restart, so the Worker never
        // takes a delayed renewal over the revocation that followed it.
        assert.isTrue(
          kept.issued.every(
            (issued, index) => index === 0 || issued > (kept.issued[index - 1] ?? ""),
          ),
          kept.issued.join(", "),
        );
        assert.isTrue(
          kept.stops >= 2,
          "reattachment stops the commands left from before the restart",
        );
        assert.isFalse(worker.state.sandboxes.has(SANDBOX));
      }).pipe(Effect.scoped),
  );

  for (const permissions of ["read", "write"] as const) {
    it.live(
      `keeps a ${permissions} sandbox when its prepared reattachment cannot stop the parent`,
      () =>
        Effect.gen(function* () {
          const worker = yield* fakeWorker;
          const storage = new StubStorage();
          const credentials = mintingProvider();
          const checkout = new CheckoutRequest({ ...request, permissions });
          const working = yield* Deferred.make<void>();
          const blocks: StubParent = () =>
            Deferred.succeed(working, undefined).pipe(Effect.andThen(Effect.never));
          yield* Effect.gen(function* () {
            const cloudflare = yield* Executor;
            const prepared = yield* cloudflare.prepare(checkout);
            const running = yield* Effect.forkChild(prepared.launch(sink));
            yield* Deferred.await(working);
            yield* Fiber.interrupt(running);
          }).pipe(Effect.scoped, Effect.provide(executor(worker, credentials, blocks, storage)));

          const refusing = yield* Ref.make(true);
          const runtime = Layer.effect(
            AttemptRuntime,
            Effect.gen(function* () {
              const original = yield* AttemptRuntime;
              return AttemptRuntime.of({
                ...original,
                cancel: (id) =>
                  Effect.gen(function* () {
                    if (yield* Ref.get(refusing))
                      return yield* new InfraFailure({ message: "Stop refused", cause: "offline" });
                    yield* original.cancel(id);
                  }),
              });
            }),
          ).pipe(Layer.provide(stubAttemptRuntime(storage)));
          const restarted = executor(
            worker,
            credentials,
            completes,
            storage,
            [ANTHROPIC],
            ACCESS_CLIENT_SECRET,
            runtime,
          );
          yield* Executor.pipe(
            Effect.flatMap((cloudflare) =>
              cloudflare.prepare(new CheckoutRequest({ ...checkout, reattach: true })),
            ),
            Effect.scoped,
            Effect.provide(restarted),
          );

          const kept = worker.state.sandboxes.get(SANDBOX);
          assert(kept !== undefined, "a failed parent stop must preserve the sandbox");
          assert.isTrue(kept.held);
          assert.isTrue(kept.paths.has(WORKTREE));
          assert.deepStrictEqual(kept.github, [
            null,
            `${TOKEN_PREFIX}1`,
            null,
            `${TOKEN_PREFIX}2`,
            null,
          ]);
          assert.deepStrictEqual(kept.providers, [0, 1, 0, 1, 0]);
          assert.notInclude(worker.state.requests, `DELETE /v1/sandboxes/${SANDBOX}`);
          assert.isFalse(kept.commands.some((line) => line.includes("'push'")));

          yield* Ref.set(refusing, false);
          yield* Executor.pipe(
            Effect.flatMap((cloudflare) =>
              cloudflare.recover(
                keptCheckoutRecovery(checkout),
                sink,
                Effect.succeed(COMMIT_AUTHOR),
              ),
            ),
            Effect.scoped,
            Effect.provide(restarted),
          );
          assert.isFalse(worker.state.sandboxes.has(SANDBOX));
        }).pipe(Effect.scoped),
    );
  }

  it.live(
    "keeps the sandbox when reattachment cannot be prepared, then removes its clean checkout after recovery",
    () =>
      Effect.gen(function* () {
        const worker = yield* fakeWorker;
        const storage = new StubStorage();
        const working = yield* Deferred.make<void>();
        const blocks: StubParent = () =>
          Deferred.succeed(working, undefined).pipe(Effect.andThen(Effect.never));
        yield* Effect.gen(function* () {
          const cloudflare = yield* Executor;
          const prepared = yield* cloudflare.prepare(request);
          const running = yield* Effect.forkChild(prepared.launch(sink));
          yield* Deferred.await(working);
          yield* Fiber.interrupt(running);
        }).pipe(
          Effect.scoped,
          Effect.provide(executor(worker, mintingProvider(), blocks, storage)),
        );

        // After the restart, GitHub doesn't answer when the reattachment asks for a token.
        const refused = yield* Executor.pipe(
          Effect.flatMap((cloudflare) =>
            cloudflare.prepare(new CheckoutRequest({ ...request, reattach: true })),
          ),
          Effect.flip,
          Effect.scoped,
          Effect.provide(executor(worker, unreachableGitHub, completes, storage)),
        );
        assert.strictEqual(refused._tag, "CredentialUnavailableError");
        const kept = worker.state.sandboxes.get(SANDBOX);
        assert(kept !== undefined, "the sandbox and its checkout stay");
        assert.isTrue(kept.held);
        assert.isTrue(kept.paths.has(WORKTREE));
        assert.notInclude(worker.state.requests, `DELETE /v1/sandboxes/${SANDBOX}`);

        const salvages: Array<AttemptSalvage> = [];
        yield* Executor.pipe(
          Effect.flatMap((cloudflare) =>
            cloudflare.recover(
              keptCheckoutRecovery(request),
              { ...sink, salvage: (salvage) => Effect.sync(() => void salvages.push(salvage)) },
              Effect.succeed(COMMIT_AUTHOR),
            ),
          ),
          Effect.scoped,
          Effect.provide(executor(worker, mintingProvider(), completes, storage)),
        );
        assert.isEmpty(salvages);
        assert.isFalse(
          kept.commands.some(
            (line) => line.includes("'push'") && line.includes(request.salvageRef),
          ),
        );
        assert.isFalse(worker.state.sandboxes.has(SANDBOX));
      }).pipe(Effect.scoped),
  );

  it.live(
    "drains an Attempt whose sandbox the platform stops: salvages, destroys it, and fails retryably",
    () =>
      Effect.gen(function* () {
        const worker = yield* fakeWorker;
        // A dirty checkout, whose salvage commit moves HEAD.
        let committed = false;
        worker.state.respond = (_sandbox, words) => {
          if (words[0] !== "git") return Option.none();
          if (words.includes("status"))
            return Option.some({ stdout: " M src/index.ts\n", exitCode: 0 });
          if (words.includes("diff")) return Option.some({ stdout: "src/index.ts\0", exitCode: 0 });
          if (words.includes("commit")) committed = true;
          return committed && words.includes("HEAD")
            ? Option.some({ stdout: `${"c".repeat(40)}\n`, exitCode: 0 })
            : Option.none();
        };
        const working = yield* Deferred.make<void>();
        const parent: StubParent = () =>
          Deferred.succeed(working, undefined).pipe(Effect.andThen(Effect.never));
        let pushes: ReadonlyArray<string> = [];
        const exit = yield* Effect.gen(function* () {
          const cloudflare = yield* Executor;
          const prepared = yield* cloudflare.prepare(request);
          const running = yield* Effect.forkChild(prepared.launch(sink));
          yield* Deferred.await(working);
          const sandbox = worker.state.sandboxes.get(SANDBOX);
          assert(sandbox !== undefined);
          sandbox.draining = true;
          const launched = yield* Fiber.await(running);
          pushes = sandbox.commands.filter((line) => line.includes("'push'"));
          return launched;
        }).pipe(Effect.scoped, Effect.provide(executor(worker, mintingProvider(), parent)));

        assert.isTrue(Exit.isFailure(exit));
        const failure = Exit.findErrorOption(exit);
        assert(Option.isSome(failure) && failure.value._tag === "InfraFailure");
        assert.include(failure.value.message, "Cloudflare is stopping the attempt's sandbox");
        assert.isTrue(
          pushes.some((line) => line.includes(request.salvageRef)),
          "the release pushes the salvage before the platform stops the container",
        );
        assert.isFalse(worker.state.sandboxes.has(SANDBOX));
      }).pipe(Effect.scoped),
  );

  it.live("destroys its orphan sandboxes without a checkout and keeps those that hold one", () =>
    Effect.gen(function* () {
      const worker = yield* fakeWorker;
      const stopped = { ...runningSandbox(`${OWNER}.stopped`, "old/execute/1"), running: false };
      const empty = runningSandbox(`${OWNER}.preflight`, "preflight");
      const holding = runningSandbox(`${OWNER}.crashed`, "crashed/execute/1", [
        "/home/usine/workspace/attempts",
        "/home/usine/workspace/attempts/crashed_execute_1",
      ]);
      // A sandbox of another instance's Worker with the same name.
      const foreign = {
        ...runningSandbox(`github-app-2.${WORKER}.other`, "other/execute/1"),
        owner: `github-app-2.${WORKER}`,
      };
      for (const sandbox of [stopped, empty, holding, foreign])
        worker.state.sandboxes.set(sandbox.name, sandbox);
      yield* Effect.gen(function* () {
        const cloudflare = yield* Executor;
        const prepared = yield* cloudflare.prepare(request);
        yield* prepared.launch(sink);
      }).pipe(Effect.scoped, Effect.provide(executor(worker, mintingProvider())));

      assert.deepStrictEqual([...worker.state.sandboxes.keys()].sort(), [
        `${OWNER}.crashed`,
        `github-app-2.${WORKER}.other`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses brains the sandbox can't run before creating a sandbox", () =>
    Effect.gen(function* () {
      const worker = yield* fakeWorker;
      yield* Effect.gen(function* () {
        const cloudflare = yield* Executor;
        const codex = yield* cloudflare
          .prepare(new CheckoutRequest({ ...request, agent: brain("codex") }))
          .pipe(Effect.flip);
        const pi = yield* cloudflare.preflight(WORKER, [brain("pi").brain], 1).pipe(Effect.flip);
        assert(codex instanceof WorkerCapabilityError && pi instanceof WorkerCapabilityError);
        assert.strictEqual(codex.capability, "harness-login");
        assert.include(codex.message, "openai");
        assert.strictEqual(pi.capability, "toolchain");
      }).pipe(Effect.scoped, Effect.provide(executor(worker, mintingProvider())));

      assert.strictEqual(worker.state.sandboxes.size, 0);
    }).pipe(Effect.scoped),
  );

  it.live("checks the assigned harness in each new sandbox before it grants credentials", () =>
    Effect.gen(function* () {
      const worker = yield* fakeWorker;
      const credentials = mintingProvider();
      const codex = new CheckoutRequest({ ...request, agent: brain("codex") });
      const refused = yield* Effect.gen(function* () {
        const cloudflare = yield* Executor;
        yield* cloudflare.preflight(WORKER, [codex.agent.brain], 1);
        // The Worker's image is redeployed under the same name, with a Codex usine doesn't support.
        worker.state.respond = (_sandbox, words) =>
          words[0] === "codex"
            ? Option.some({ stdout: "codex-cli 0.150.0\n", exitCode: 0 })
            : Option.none();
        return yield* cloudflare.prepare(codex).pipe(Effect.flip);
      }).pipe(
        Effect.scoped,
        Effect.provide(executor(worker, credentials, completes, new StubStorage(), [OPENAI])),
      );

      assert(refused instanceof WorkerCapabilityError);
      assert.strictEqual(refused.capability, "toolchain");
      assert.include(refused.message, "codex-cli 0.150.0");
      assert.deepStrictEqual(credentials.minted, []);
      assert.deepStrictEqual(
        worker.state.requests.filter((line) => line.startsWith(`PUT /v1/sandboxes/${SANDBOX}`)),
        [`PUT /v1/sandboxes/${SANDBOX}`],
      );
      assert.isFalse(worker.state.sandboxes.has(SANDBOX));
    }).pipe(Effect.scoped),
  );

  it.live("reports a refused Access token and a missing image as capability gaps", () =>
    Effect.gen(function* () {
      const worker = yield* fakeWorker;
      const refused = yield* Executor.pipe(
        Effect.flatMap((cloudflare) => cloudflare.preflight(WORKER, [], 1)),
        Effect.flip,
        Effect.scoped,
        Effect.provide(
          executor(worker, mintingProvider(), completes, new StubStorage(), [ANTHROPIC], "wrong"),
        ),
      );
      worker.state.images = ["other"];
      const missing = yield* Executor.pipe(
        Effect.flatMap((cloudflare) => cloudflare.preflight(WORKER, [], 1)),
        Effect.flip,
        Effect.scoped,
        Effect.provide(executor(worker, mintingProvider())),
      );

      assert(refused instanceof WorkerCapabilityError && missing instanceof WorkerCapabilityError);
      assert.strictEqual(refused.capability, "credentials");
      assert.strictEqual(missing.capability, "toolchain");
      assert.include(missing.message, 'no image "usine"');
    }).pipe(Effect.scoped),
  );
});

describe("sandbox shell", () => {
  const run = (url: URL, line: string, secret = ACCESS_CLIENT_SECRET) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(process.execPath, ["--no-warnings", SHELL, SANDBOX, "--", line], {
          env: {
            [SHELL_ENVIRONMENT.workerUrl]: url.origin,
            [SHELL_ENVIRONMENT.accessClientId]: ACCESS_CLIENT_ID,
            [SHELL_ENVIRONMENT.accessClientSecret]: secret,
          },
          extendEnv: false,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode: Number(exitCode) };
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.live("attaches to a command's output after its stream drops, and keeps its exit code", () =>
    Effect.gen(function* () {
      const worker = yield* fakeWorker;
      worker.state.sandboxes.set(SANDBOX, runningSandbox(SANDBOX, request.attemptId));
      const line = "exec 'git' 'log' '--oneline'";
      worker.state.respond = (_sandbox, words) =>
        words[1] === "log"
          ? Option.some({ stdout: "abc123 first\ndef456 second\n", exitCode: 3 })
          : Option.none();
      worker.state.dropOnce.add(line);
      const result = yield* run(worker.url, line);

      assert.deepStrictEqual(result, {
        stdout: "abc123 first\ndef456 second\n",
        stderr: "",
        exitCode: 3,
      });
      assert.isTrue(worker.state.requests.some((path) => path.endsWith("/attach")));
    }).pipe(Effect.scoped),
  );

  it.live("exits 255 like ssh when the Worker refuses it or the sandbox is gone", () =>
    Effect.gen(function* () {
      const worker = yield* fakeWorker;
      const refused = yield* run(worker.url, "exec 'true'", "wrong");
      const gone = yield* run(worker.url, "exec 'true'");

      assert.strictEqual(refused.exitCode, 255);
      assert.strictEqual(gone.exitCode, 255);
      assert.include(gone.stderr, SANDBOX);
    }).pipe(Effect.scoped),
  );
});

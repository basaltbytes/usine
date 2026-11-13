import { NodeFileSystem, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { SandboxRequest, SupervisorSandbox } from "@usine/agents/supervisor";
import { Harness } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { RepositoryName } from "@usine/core/repository";
import { ContainerImage, type GatewayLlmProtocol } from "@usine/core/worker";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Redacted,
  Result,
  Sink,
  Stream,
} from "effect";
import { HttpServerRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { GatewayModelError, type GatewayModelRoute } from "../../src/ssh/gateway/model-route.ts";
import { containerSandboxLayer, detectSandboxRuntime } from "../../src/supervisor/container.ts";
import { relayModelRequest } from "../../src/supervisor/model-relay.ts";
import { prepareSupervisorSources } from "../../src/supervisor/sources.ts";

const encoder = new TextEncoder();

/**
 * A spawner on which `installed` runtimes answer `info` with their output, and every other
 * command is missing, as on a host without them.
 */
const runtimes = (
  installed: Readonly<
    Record<string, { readonly stdout: string; readonly stderr?: string; readonly exitCode: number }>
  >,
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
        const answer = installed[command.command];
        if (answer === undefined)
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `spawn ${command.command} ENOENT`,
          });
        assert.strictEqual(command.args[0], "info");
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(answer.stdout)),
          stderr: Stream.make(encoder.encode(answer.stderr ?? "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

const unusedRoute: GatewayModelRoute = {
  credential: () => Effect.die("the test calls no model"),
  request: () => Effect.die("the test calls no model"),
};

describe("the supervisor sandbox's container runtime", () => {
  it.effect("is unavailable, with the reason, on a host without Podman or Docker", () =>
    Effect.gen(function* () {
      const detected = yield* detectSandboxRuntime(Option.none());
      assert(Result.isFailure(detected));
      assert.strictEqual(
        detected.failure.message,
        "Supervisor sessions run in a container, and Podman or Docker isn't installed on the orchestrator host",
      );

      // The orchestrator still starts: the sandbox reports why, and every turn fails with it.
      const sandbox = yield* SupervisorSandbox.pipe(
        Effect.provide(
          containerSandboxLayer({
            root: "/unused",
            image: ContainerImage.make("docker.io/library/node:22-slim"),
            runtime: Option.none(),
            route: Option.some(Effect.succeed(unusedRoute)),
          }),
        ),
      );
      assert.deepStrictEqual(sandbox.unavailable, Option.some(detected.failure));
      const refused = yield* sandbox
        .open(
          SandboxRequest.make({
            conversation: AgentSessionId.make("supervisor:1"),
            harness: Harness.make("claude"),
            sources: [],
          }),
        )
        .pipe(Effect.scoped, Effect.flip);
      assert.deepStrictEqual(refused, detected.failure);
    }).pipe(Effect.provide([runtimes({}), NodeFileSystem.layer])),
  );

  it.effect("says why an installed runtime can't run containers", () =>
    Effect.gen(function* () {
      const detected = yield* detectSandboxRuntime(Option.none());
      assert(Result.isFailure(detected));
      assert.strictEqual(
        detected.failure.message,
        "Supervisor sessions run in a container, and podman is installed but can't run containers: cannot set up namespace using newuidmap",
      );
    }).pipe(
      Effect.provide(
        runtimes({
          podman: {
            stdout: "",
            stderr: "cannot set up namespace using newuidmap\nmore detail",
            exitCode: 125,
          },
        }),
      ),
    ),
  );

  it.effect("prefers rootless Podman, and falls back to Docker", () =>
    Effect.gen(function* () {
      const podman = yield* detectSandboxRuntime(Option.none()).pipe(
        Effect.provide(
          runtimes({
            podman: { stdout: "true\n", exitCode: 0 },
            docker: { stdout: "[]", exitCode: 0 },
          }),
        ),
      );
      assert.deepStrictEqual(podman, Result.succeed({ runtime: "podman", rootless: true }));
      const docker = yield* detectSandboxRuntime(Option.none()).pipe(
        Effect.provide(runtimes({ docker: { stdout: '["name=seccomp"]', exitCode: 0 } })),
      );
      assert.deepStrictEqual(docker, Result.succeed({ runtime: "docker", rootless: false }));
    }),
  );

  it.effect("is unavailable without the instance's model route", () =>
    Effect.gen(function* () {
      const sandbox = yield* SupervisorSandbox.pipe(
        Effect.provide(
          containerSandboxLayer({
            root: "/unused",
            image: ContainerImage.make("docker.io/library/node:22-slim"),
            runtime: Option.none(),
            route: Option.none(),
          }),
        ),
      );
      assert.deepStrictEqual(
        Option.map(sandbox.unavailable, ({ message }) => message),
        Option.some(
          "Supervisor sessions reach the model through the instance's gateway, and no worker gateway is configured",
        ),
      );
    }).pipe(
      Effect.provide([runtimes({ podman: { stdout: "true", exitCode: 0 } }), NodeFileSystem.layer]),
    ),
  );
});

describe("the supervisor model relay", () => {
  const relay = (request: Request, route: GatewayModelRoute) =>
    relayModelRequest(route).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.map((response) => response.status),
    );

  it.effect("sends model calls through the instance's route without the session's credential", () =>
    Effect.gen(function* () {
      const sent: Array<{
        readonly protocol: GatewayLlmProtocol;
        readonly body: string;
        readonly headers: Readonly<Record<string, string>>;
      }> = [];
      const route: GatewayModelRoute = {
        credential: () => Effect.succeedNone,
        request: (protocol, body, headers) =>
          Effect.sync(() => {
            sent.push({ protocol, body, headers });
            return new Response("{}", {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          }),
      };
      const status = yield* relay(
        new Request("http://127.0.0.1:8787/anthropic-messages/v1/messages?beta=true", {
          method: "POST",
          body: '{"model":"m"}',
          headers: {
            authorization: "Bearer usine-supervisor-sandbox",
            "x-api-key": "usine-supervisor-sandbox",
            "anthropic-version": "2023-06-01",
          },
        }),
        route,
      );
      assert.strictEqual(status, 201);
      assert.lengthOf(sent, 1);
      assert.strictEqual(sent[0]?.protocol, "anthropic-messages");
      assert.strictEqual(sent[0]?.body, '{"model":"m"}');
      assert.strictEqual(sent[0]?.headers["anthropic-version"], "2023-06-01");
      assert.notProperty(sent[0]?.headers, "authorization");
      assert.notProperty(sent[0]?.headers, "x-api-key");

      yield* relay(
        new Request("http://127.0.0.1:8787/openai-responses/v1/responses", {
          method: "POST",
          body: "{}",
        }),
        route,
      );
      assert.strictEqual(sent[1]?.protocol, "openai-responses");
    }),
  );

  it.effect("refuses every other request and reports a route that fails", () =>
    Effect.gen(function* () {
      const failing: GatewayModelRoute = {
        credential: () => Effect.succeedNone,
        request: () =>
          Effect.fail(GatewayModelError.make({ message: "Can't reach gateway gw-1: refused." })),
      };
      const statuses = yield* Effect.forEach(
        [
          new Request("http://127.0.0.1:8787/anthropic-messages/v1/models"),
          new Request("http://127.0.0.1:8787/v1/messages", { method: "POST", body: "{}" }),
          new Request("http://127.0.0.1:8787/anthropic-messages/v1/messages", {
            method: "POST",
            body: "{}",
          }),
        ],
        (request) => relay(request, failing),
      );
      assert.deepStrictEqual(statuses, [404, 404, 502]);
    }),
  );
});

describe("the supervisor's source", () => {
  it.live("exports each repository's default branch head without its history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (cwd: string, ...args: ReadonlyArray<string>) =>
        spawner.string(
          ChildProcess.make("git", ["-C", cwd, ...args], {
            env: {
              GIT_AUTHOR_NAME: "usine",
              GIT_AUTHOR_EMAIL: "usine@example.com",
              GIT_COMMITTER_NAME: "usine",
              GIT_COMMITTER_EMAIL: "usine@example.com",
            },
            extendEnv: true,
          }),
        );
      const origin = yield* fs.makeTempDirectoryScoped({ prefix: "usine-source-origin-" });
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      yield* git(origin, "init", "--quiet", "--initial-branch=main");
      yield* fs.writeFileString(`${origin}/README.md`, "first\n");
      yield* git(origin, "add", "README.md");
      yield* git(origin, "commit", "--quiet", "-m", "first");
      const repository = RepositoryName.make("acme/demo");
      const tokens: Array<RepositoryName> = [];
      const sourceOrigin = {
        url: () => `file://${origin}`,
        token: (name: RepositoryName) =>
          Effect.sync(() => {
            tokens.push(name);
            return Option.some(Redacted.make("ghs_unused"));
          }),
      };

      const [first] = yield* prepareSupervisorSources(root, [repository], sourceOrigin);
      assert(first !== undefined);
      const head = yield* git(origin, "rev-parse", "HEAD");
      assert.strictEqual(first.revision, head.trim());
      const firstReadme = yield* fs.readFileString(`${first.directory}/README.md`);
      assert.strictEqual(firstReadme, "first\n");
      const history = yield* fs.exists(`${first.directory}/.git`);
      assert.isFalse(history, "the tree has no history");
      assert.deepStrictEqual(tokens, [repository]);

      yield* fs.writeFileString(`${origin}/README.md`, "second\n");
      yield* git(origin, "commit", "--quiet", "-am", "second");
      const [second] = yield* prepareSupervisorSources(root, [repository], sourceOrigin);
      assert(second !== undefined);
      assert.notStrictEqual(second.revision, first.revision);
      const secondReadme = yield* fs.readFileString(`${second.directory}/README.md`);
      assert.strictEqual(secondReadme, "second\n");
      const kept = yield* fs.exists(first.directory);
      assert.isTrue(kept, "a turn that started on the previous head still reads it");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails with the reason when a repository can't be fetched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const failure = yield* prepareSupervisorSources(root, [RepositoryName.make("acme/gone")], {
        url: () => `file://${root}/missing`,
        token: () => Effect.succeedNone,
      }).pipe(Effect.flip);
      assert.match(
        failure.message,
        /^Can't prepare the source of acme\/gone: git exited with code 128: /u,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

import { NodeFileSystem, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { SandboxRequest, SupervisorSandbox } from "@usine/agents/supervisor";
import { Harness } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { RepositoryName, safeSegment } from "@usine/core/repository";
import { ContainerImage, type GatewayLlmProtocol } from "@usine/core/worker";
import {
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Redacted,
  Result,
  Scope,
  Sink,
  Stream,
} from "effect";
import { HttpServerRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { GatewayModelError, type GatewayModelRoute } from "../../src/ssh/gateway/model-route.ts";
import {
  containerSandboxLayer,
  detectSandboxRuntime,
  sandboxRunArguments,
} from "../../src/supervisor/container.ts";
import { relayModelRequest } from "../../src/supervisor/model-relay.ts";
import { makeSupervisorSources, type SourceOrigin } from "../../src/supervisor/sources.ts";

const encoder = new TextEncoder();

/** What a fake command prints and its exit code, or `hang` for one that never exits. */
type Answer =
  | { readonly stdout: string; readonly stderr?: string; readonly exitCode: number }
  | "hang";

/**
 * A spawner that answers each command with `answer`, and on which a command that `answer` leaves
 * `undefined` is missing, as on a host without it. Records every command line in `calls`.
 */
const spawning = (
  answer: (command: string, args: ReadonlyArray<string>) => Answer | undefined,
  calls: Array<ReadonlyArray<string>> = [],
) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
        calls.push([command.command, ...command.args]);
        const answered = answer(command.command, command.args);
        if (answered === undefined)
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `spawn ${command.command} ENOENT`,
          });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            answered === "hang"
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(answered.exitCode)),
          isRunning: Effect.succeed(answered === "hang"),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: answered === "hang" ? Stream.never : Stream.make(encoder.encode(answered.stdout)),
          stderr:
            answered === "hang" ? Stream.never : Stream.make(encoder.encode(answered.stderr ?? "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );

/**
 * A spawner on which `installed` runtimes answer `info` with their output, and every other
 * command is missing, as on a host without them.
 */
const runtimes = (installed: Readonly<Record<string, Answer>>) =>
  spawning((command, args) => {
    const answer = installed[command];
    if (answer !== undefined) assert.strictEqual(args[0], "info");
    return answer;
  });

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

  it.effect("counts a runtime that doesn't answer within 15 seconds as missing", () =>
    Effect.gen(function* () {
      const fiber = yield* detectSandboxRuntime(Option.some("podman")).pipe(Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      const detected = yield* Fiber.join(fiber);
      assert(Result.isFailure(detected));
      assert.strictEqual(
        detected.failure.message,
        "Supervisor sessions run in a container, and podman didn't answer within 15 seconds",
      );
    }).pipe(Effect.provide(runtimes({ podman: "hang" }))),
  );

  it("runs a sandbox without network, privileges, or a writable root, labeled for cleanup", () => {
    const args = sandboxRunArguments({
      name: "usine-supervisor-c1-1",
      root: "/instance/.usine/supervisor",
      conversation: "supervisor:c1",
      runtime: { runtime: "podman", rootless: true },
      image: ContainerImage.make("docker.io/library/node:22-slim"),
      paths: {
        root: "/instance/.usine/supervisor/conversations/c1",
        home: "/instance/.usine/supervisor/conversations/c1/home",
        workspace: "/instance/.usine/supervisor/conversations/c1/workspace",
      },
      sources: [],
      relayDirectory: "/tmp/usine-supervisor-1",
    });
    const pairs = args.slice(0, -1).map((arg, index) => `${arg} ${args[index + 1]}`);
    for (const pair of [
      "--network none",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--label usine.supervisor.root=/instance/.usine/supervisor",
      "--label usine.supervisor.conversation=supervisor:c1",
      "--volume /instance/.usine/supervisor/conversations/c1/workspace:/instance/.usine/supervisor/conversations/c1/workspace:ro",
    ])
      assert.include(pairs, pair);
    assert.include(args, "--read-only");
    assert.include(args, "--rm");
  });
});

describe("a supervisor sandbox on a container runtime", () => {
  /** A Podman that runs every command, and lists `left` as the containers that it still runs. */
  const podman = (calls: Array<ReadonlyArray<string>>, left: ReadonlyArray<string> = []) =>
    spawning((command, args) => {
      if (command !== "podman") return undefined;
      if (args[0] === "info") return { stdout: "true", exitCode: 0 };
      if (args[0] === "ps") return { stdout: left.map((id) => `${id}\n`).join(""), exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    }, calls);

  const route: GatewayModelRoute = {
    credential: () => Effect.succeedNone,
    request: () => Effect.die("the test calls no model"),
  };

  const sandboxAt = (root: string) =>
    SupervisorSandbox.pipe(
      Effect.provide(
        containerSandboxLayer({
          root,
          image: ContainerImage.make("docker.io/library/node:22-slim"),
          runtime: Option.none(),
          route: Option.some(Effect.succeed(route)),
        }),
      ),
    );

  const codexTurn = (conversation: string) =>
    SandboxRequest.make({
      conversation: AgentSessionId.make(conversation),
      harness: Harness.make("codex"),
      sources: [],
    });

  it.live("writes the harness's settings without following a link that a turn left", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const instance = yield* fs.makeTempDirectoryScoped({ prefix: "usine-instance-" });
      yield* fs.writeFileString(`${instance}/usine.db`, "instance database");
      const root = `${instance}/.usine/supervisor`;
      const conversation = `${root}/conversations/${safeSegment("supervisor:c1")}`;
      // A Codex shell in an earlier turn replaced the settings file with a link to the database.
      yield* fs.makeDirectory(`${conversation}/home/.codex`, { recursive: true });
      yield* fs.symlink(`${instance}/usine.db`, `${conversation}/home/.codex/config.toml`);
      // And another conversation's home with a link to the instance folder.
      const other = `${root}/conversations/${safeSegment("supervisor:c2")}`;
      yield* fs.makeDirectory(other, { recursive: true });
      yield* fs.symlink(instance, `${other}/home`);

      const calls: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        yield* sandbox.open(codexTurn("supervisor:c1")).pipe(Effect.scoped);
        yield* sandbox.open(codexTurn("supervisor:c2")).pipe(Effect.scoped);
      }).pipe(Effect.provide(podman(calls)));

      const database = yield* fs.readFileString(`${instance}/usine.db`);
      assert.strictEqual(database, "instance database");
      const settings = yield* fs.lstat(`${conversation}/home/.codex/config.toml`);
      assert.strictEqual(settings.type, "File");
      const written = yield* fs.readFileString(`${conversation}/home/.codex/config.toml`);
      assert.include(written, 'model_provider = "usine-gateway"');
      const home = yield* fs.lstat(`${other}/home`);
      assert.strictEqual(home.type, "Directory");
      const leaked = yield* fs.exists(`${instance}/.codex`);
      assert.isFalse(leaked, "nothing is written through the linked home");
      const otherSettings = yield* fs.lstat(`${other}/home/.codex/config.toml`);
      assert.strictEqual(otherSettings.type, "File");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live(
    "removes the sandboxes that an earlier process left, and runs one turn per conversation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
        const calls: Array<ReadonlyArray<string>> = [];
        yield* Effect.gen(function* () {
          const sandbox = yield* sandboxAt(root);
          assert.deepStrictEqual(
            calls.filter(([, command]) => command === "ps" || command === "rm"),
            [
              [
                "podman",
                "ps",
                "--all",
                "--quiet",
                "--filter",
                `label=usine.supervisor.root=${root}`,
              ],
              ["podman", "rm", "--force", "left-1"],
              ["podman", "rm", "--force", "left-2"],
            ],
          );
          const refused = yield* Effect.gen(function* () {
            yield* sandbox.open(codexTurn("supervisor:c1"));
            return yield* sandbox.open(codexTurn("supervisor:c1")).pipe(Effect.scoped, Effect.flip);
          }).pipe(Effect.scoped);
          assert.strictEqual(
            refused.message,
            "Another turn of this supervisor conversation is running",
          );
          // The turn's scope has closed, so the conversation's next turn opens.
          yield* sandbox.open(codexTurn("supervisor:c1")).pipe(Effect.scoped);
        }).pipe(Effect.provide(podman(calls, ["left-1", "left-2"])));
        const started = calls.filter(([, command]) => command === "run");
        const removed = calls.filter(([, command]) => command === "rm").slice(2);
        assert.lengthOf(started, 2);
        assert.deepStrictEqual(
          removed.map(([, , , name]) => name),
          started.map((args) => args[args.indexOf("--name") + 1]),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
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
            "proxy-authorization": "Basic usine-supervisor-sandbox",
            "x-usine-gateway-token": "ugw1.chosen.by-the-session",
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
      assert.deepStrictEqual(Object.keys(sent[0]?.headers ?? {}).sort(), [
        "anthropic-version",
        "content-type",
      ]);

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
          new Request("http://127.0.0.1:8787/anthropic-messages/v1/messages"),
          new Request("http://127.0.0.1:8787/openai-responses/v1/responses", {
            method: "PUT",
            body: "{}",
          }),
          new Request("http://127.0.0.1:8787/v1/messages", { method: "POST", body: "{}" }),
          new Request("http://127.0.0.1:8787/anthropic-messages/v1/messages", {
            method: "POST",
            body: "{}",
          }),
        ],
        (request) => relay(request, failing),
      );
      assert.deepStrictEqual(statuses, [404, 404, 404, 404, 502]);
    }),
  );
});

describe("the supervisor's source", () => {
  const git = Effect.fn(function* (cwd: string, ...args: ReadonlyArray<string>) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(
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
  });

  /** A repository with one commit, and the origin that fetches it. */
  const originRepository = Effect.fn(function* (tokens: Array<RepositoryName> = []) {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-source-origin-" });
    yield* git(directory, "init", "--quiet", "--initial-branch=main");
    yield* fs.writeFileString(`${directory}/README.md`, "first\n");
    yield* git(directory, "add", "README.md");
    yield* git(directory, "commit", "--quiet", "-m", "first");
    const commit = (contents: string) =>
      fs
        .writeFileString(`${directory}/README.md`, contents)
        .pipe(Effect.andThen(git(directory, "commit", "--quiet", "-am", contents)));
    const origin: SourceOrigin = {
      url: () => `file://${directory}`,
      token: (name) =>
        Effect.sync(() => {
          tokens.push(name);
          return Option.some(Redacted.make("ghs_unused"));
        }),
    };
    return { directory, commit, origin };
  });

  const repository = RepositoryName.make("acme/demo");

  it.live("exports each repository's default branch head without its history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const tokens: Array<RepositoryName> = [];
      const origin = yield* originRepository(tokens);
      const sources = yield* makeSupervisorSources(root, origin.origin);

      const [first] = yield* sources.prepare([repository]);
      assert(first !== undefined);
      const head = yield* git(origin.directory, "rev-parse", "HEAD");
      assert.strictEqual(first.revision, head.trim());
      const readme = yield* fs.readFileString(`${first.directory}/README.md`);
      assert.strictEqual(readme, "first\n");
      const history = yield* fs.exists(`${first.directory}/.git`);
      assert.isFalse(history, "the tree has no history");
      assert.deepStrictEqual(tokens, [repository]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps a tree while a turn holds it, however old, and removes it after", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const origin = yield* originRepository();
      const sources = yield* makeSupervisorSources(root, origin.origin);

      // A turn that started on the first head two days ago still reads it.
      const firstTurn = yield* Scope.make();
      const [first] = yield* sources.prepare([repository]).pipe(Scope.provide(firstTurn));
      assert(first !== undefined);
      const now = yield* Clock.currentTimeMillis;
      const twoDaysAgo = (now - Duration.toMillis(Duration.days(2))) / 1000;
      yield* fs.utimes(first.directory, twoDaysAgo, twoDaysAgo);

      yield* origin.commit("second\n");
      const secondTurn = yield* Scope.make();
      const [second] = yield* sources.prepare([repository]).pipe(Scope.provide(secondTurn));
      assert(second !== undefined);
      assert.notStrictEqual(second.revision, first.revision);
      const secondReadme = yield* fs.readFileString(`${second.directory}/README.md`);
      assert.strictEqual(secondReadme, "second\n");
      const kept = yield* fs.readFileString(`${first.directory}/README.md`);
      assert.strictEqual(kept, "first\n", "the first turn still reads the previous head");

      yield* Scope.close(firstTurn, Exit.void);
      const removed = yield* fs.exists(first.directory);
      assert.isFalse(removed, "a tree that is no longer the head goes once no turn holds it");
      yield* Scope.close(secondTurn, Exit.void);
      const head = yield* fs.exists(second.directory);
      assert.isTrue(head, "the head's tree stays for the next turn");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("prepares one repository for concurrent turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const origin = yield* originRepository();
      const sources = yield* makeSupervisorSources(root, origin.origin);
      for (const round of [1, 2, 3, 4, 5]) {
        yield* origin.commit(`round ${round}\n`);
        const head = (yield* git(origin.directory, "rev-parse", "HEAD")).trim();
        const prepared = yield* Effect.forEach([1, 2, 3], () => sources.prepare([repository]), {
          concurrency: "unbounded",
        });
        for (const [source] of prepared) {
          assert(source !== undefined);
          assert.strictEqual(source.revision, head);
          const readme = yield* fs.readFileString(`${source.directory}/README.md`);
          assert.strictEqual(readme, `round ${round}\n`);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails with the reason when a repository can't be fetched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const sources = yield* makeSupervisorSources(root, {
        url: () => `file://${root}/missing`,
        token: () => Effect.succeedNone,
      });
      const failure = yield* sources.prepare([RepositoryName.make("acme/gone")]).pipe(Effect.flip);
      assert.match(
        failure.message,
        /^Can't prepare the source of acme\/gone: git exited with code 128: /u,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

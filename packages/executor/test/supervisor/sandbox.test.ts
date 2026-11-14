import { spawning, podman, type Answer, type RuntimeState } from "./runtime-fixture.ts";
import { directoryName } from "../../src/supervisor/names.ts";
import { bindMount } from "../../src/bind-mount.ts";
import { NodeFileSystem, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { SandboxRequest, SupervisorSandbox, SupervisorSource } from "@usine/agents/supervisor";
import { Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { ContainerImage, type GatewayLlmProtocol } from "@usine/core/worker";
import {
  Clock,
  Context,
  Layer,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Logger,
  Option,
  Redacted,
  Result,
  Scope,
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
            model: ModelId.make("m"),
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
      sources: ["acme/one", "acme/two"].map((repository) =>
        SupervisorSource.make({
          repository: RepositoryName.make(repository),
          revision: CommitSha.make("a".repeat(40)),
          directory: `/source:${repository},tree`,
        }),
      ),
      relayDirectory: "/tmp/usine-supervisor-1",
    });
    const pairs = args.slice(0, -1).map((arg, index) => `${arg} ${args[index + 1]}`);
    for (const pair of [
      "--network none",
      "--pull never",
      "--log-driver none",
      "--shm-size 16m",
      "--memory 1024m",
      "--memory-swap 1024m",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--label usine.supervisor.root=/instance/.usine/supervisor",
      "--label usine.supervisor.conversation=supervisor:c1",
      '--mount type=bind,"source=/instance/.usine/supervisor/conversations/c1/workspace","destination=/instance/.usine/supervisor/conversations/c1/workspace",readonly',
      // A writable relay directory would let a shell replace the socket that ends the container.
      '--mount type=bind,"source=/tmp/usine-supervisor-1","destination=/run/usine",readonly',
    ])
      assert.include(pairs, pair);
    assert.include(args, "--read-only");
    assert.include(args, "--user");
    for (const flag of [
      "--pids-limit",
      "--memory",
      "--memory-swap",
      "--cpus",
      "--pull",
      "--log-driver",
    ])
      assert.include(args, flag);
    assert.include(args, "/tmp:rw,nosuid,nodev,size=64m");
    assert.include(args, "--rm");
    const sourceMounts = args.filter((arg) => arg.includes('"source=/source:'));
    assert.lengthOf(sourceMounts, 2);
    assert.isTrue(sourceMounts.every((mount) => mount.endsWith(",readonly")));
    assert.include(sourceMounts[0]!, '"source=/source:acme/one,tree"');
  });
});

describe("a supervisor sandbox on a container runtime", () => {
  const route: GatewayModelRoute = {
    credential: () => Effect.succeedNone,
    request: () => Effect.die("the test calls no model"),
  };

  const sandboxAt = (root: string) =>
    containerSandboxLayer({
      root,
      image: ContainerImage.make("docker.io/library/node:22-slim"),
      runtime: Option.none(),
      route: Option.some(Effect.succeed(route)),
    }).pipe(
      Layer.build,
      Effect.map((context) => Context.get(context, SupervisorSandbox)),
    );

  const codexTurn = (conversation: string) =>
    SandboxRequest.make({
      model: ModelId.make("m"),
      conversation: AgentSessionId.make(conversation),
      harness: Harness.make("codex"),
      sources: [],
    });

  it.live("refuses startup while labeled containers cannot be removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const sandbox = yield* sandboxAt(root);
      assert(Option.isSome(sandbox.unavailable));
      const error = yield* sandbox.open(codexTurn("blocked")).pipe(Effect.flip);
      assert.include(error.message, "earlier process remain");
    }).pipe(
      Effect.scoped,
      Effect.provide([NodeFileSystem.layer, podman([], ["leftover"], { starts: true }, false)]),
    ),
  );

  it.live("removes labeled containers again when the sandbox shuts down", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const scope = yield* Scope.make();
      const sandbox = yield* sandboxAt(root).pipe(
        Scope.provide(scope),
        Effect.provide(podman(calls)),
      );
      const turnScope = yield* Scope.make();
      yield* sandbox.open(codexTurn("active-at-shutdown")).pipe(Scope.provide(turnScope));
      const started = calls.find(([, command]) => command === "run");
      assert(started !== undefined);
      const name = started[started.indexOf("--name") + 1];
      assert(name !== undefined);
      const before = calls.length;
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(
        calls.slice(before).filter(([, command]) => command === "rm"),
        [["podman", "rm", "--force", name]],
      );
      yield* Scope.close(turnScope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("opens with a cached image during a registry outage without pulling", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        yield* sandbox.open(codexTurn("cached")).pipe(Effect.scoped);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          podman(calls, [], {
            starts: true,
            image: { stdout: "cached", exitCode: 0 },
            pull: { stdout: "", stderr: "registry unavailable", exitCode: 1 },
          }),
        ),
      );
      assert.isFalse(calls.some(([, command]) => command === "pull"));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("starts during a stalled pull and recovers after a timed-out preparation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const calls: Array<ReadonlyArray<string>> = [];
      const runtime: RuntimeState = { starts: true, pull: "hang" };
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        assert(Option.isNone(sandbox.unavailable));
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => calls.some(([, command]) => command === "pull") }),
          ),
        );
        const waiting = yield* sandbox
          .open(codexTurn("waiting"))
          .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const refused = yield* Fiber.join(waiting);
        assert.include(refused.message, "still being prepared");
        yield* TestClock.adjust("270 seconds");
        runtime.pull = { stdout: "", exitCode: 0 };
        yield* TestClock.adjust("1 minute");
        yield* sandbox.open(codexTurn("recovered")).pipe(Effect.scoped);
        assert.lengthOf(
          calls.filter(([, command]) => command === "pull"),
          2,
        );
      }).pipe(Effect.scoped, Effect.provide(podman(calls, [], runtime)));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("writes the harness's settings without following a link that a turn left", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const instance = yield* fs.makeTempDirectoryScoped({ prefix: "usine-instance-" });
      yield* fs.writeFileString(`${instance}/usine.db`, "instance database");
      const root = `${instance}/.usine/supervisor`;
      const conversation = `${root}/conversations/${directoryName("supervisor:c1")}`;
      // A Codex shell in an earlier turn replaced the settings file with a link to the database.
      yield* fs.makeDirectory(`${conversation}/home/.codex`, { recursive: true });
      yield* fs.symlink(`${instance}/usine.db`, `${conversation}/home/.codex/config.toml`);
      // And another conversation's home with a link to the instance folder.
      const other = `${root}/conversations/${directoryName("supervisor:c2")}`;
      yield* fs.makeDirectory(other, { recursive: true });
      yield* fs.symlink(instance, `${other}/home`);

      // And a third conversation's settings file with a directory.
      const third = `${root}/conversations/${directoryName("supervisor:c3")}`;
      yield* fs.makeDirectory(`${third}/home/.codex/config.toml/keep`, { recursive: true });
      yield* fs.writeFileString(`${third}/home/.codex/config.toml/keep/notes`, "notes");

      const calls: Array<ReadonlyArray<string>> = [];
      const warnings: Array<unknown> = [];
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        yield* sandbox.open(codexTurn("supervisor:c1")).pipe(Effect.scoped);
        yield* sandbox.open(codexTurn("supervisor:c2")).pipe(Effect.scoped);
        yield* sandbox.open(codexTurn("supervisor:c3")).pipe(Effect.scoped);
      }).pipe(
        Effect.provide([
          podman(calls),
          Logger.layer([
            Logger.make<unknown, void>(({ logLevel, message }) => {
              if (logLevel === "Warn") warnings.push(message);
            }),
          ]),
        ]),
      );
      // Each replacement is logged with its path and the entry it replaced.
      assert.deepStrictEqual(warnings, [
        [
          "Replaced an entry in a supervisor conversation with a settings file",
          { path: `${conversation}/home/.codex/config.toml`, type: "SymbolicLink" },
        ],
        [
          "Replaced a file in a supervisor conversation with a directory",
          { path: `${other}/home`, type: "SymbolicLink" },
        ],
        [
          "Replaced an entry in a supervisor conversation with a settings file",
          { path: `${third}/home/.codex/config.toml`, type: "Directory" },
        ],
      ]);
      const thirdSettings = yield* fs.readFileString(`${third}/home/.codex/config.toml`);
      assert.include(thirdSettings, 'model_provider = "usine-gateway"');

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
            calls.filter(([, command]) => command === "ps" || command === "rm").slice(0, 3),
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
        const cleanup = calls
          .filter(
            ([command, flag]) =>
              (command === "podman" && flag === "rm") ||
              (command === "fusermount" && flag === "-u"),
          )
          .slice(2);
        assert.deepStrictEqual(
          cleanup.map(([command]) => command),
          ["podman", "fusermount", "podman", "fusermount"],
        );
        assert.deepStrictEqual(
          removed.map(([, , , name]) => name),
          started.map((args) => args[args.indexOf("--name") + 1]),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
  it.live("gives colliding legacy conversation IDs distinct directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const calls: Array<ReadonlyArray<string>> = [];
      const settings = `${root}/conversations/${directoryName("supervisor:c1")}/home/.codex/config.toml`;
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        yield* sandbox.open(codexTurn("supervisor:c1"));
        // The running turn's shell edits its settings, as it can.
        yield* fs.remove(settings);
        yield* fs.writeFileString(settings, "edited by the running turn\n");
        const repeated = yield* sandbox
          .open(codexTurn("supervisor:c1"))
          .pipe(Effect.scoped, Effect.flip);
        assert.include(repeated.message, "Another turn");
        for (const distinct of ["supervisor/c1", "supervisor_c1", ".", "..", "/"]) {
          assert.notStrictEqual(directoryName(distinct), directoryName("supervisor:c1"));
          yield* sandbox.open(codexTurn(distinct)).pipe(Effect.scoped);
        }
        const retained = yield* fs.readFileString(settings);
        assert.strictEqual(retained, "edited by the running turn\n");
        yield* sandbox.open(codexTurn("supervisor:c2")).pipe(Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(podman(calls)));
      assert.lengthOf(
        calls.filter(([, command]) => command === "run"),
        7,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("mounts an existing workspace for a turn without sources, and with them after", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const tree = yield* fs.makeTempDirectoryScoped({ prefix: "usine-tree-" });
      const workspace = `${root}/conversations/${directoryName("supervisor:c1")}/workspace`;
      const calls: Array<ReadonlyArray<string>> = [];
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        const seat = yield* sandbox.open(codexTurn("supervisor:c1")).pipe(Effect.scoped);
        assert.strictEqual(seat.cwd, workspace);
        const created = yield* fs.lstat(workspace);
        assert.strictEqual(created.type, "Directory");
        // The conversation's next turn mounts a source in the same workspace.
        yield* sandbox
          .open(
            SandboxRequest.make({
              model: ModelId.make("m"),
              conversation: AgentSessionId.make("supervisor:c1"),
              harness: Harness.make("codex"),
              sources: [
                SupervisorSource.make({
                  repository: RepositoryName.make("acme/demo"),
                  revision: CommitSha.make("a".repeat(40)),
                  directory: tree,
                }),
              ],
            }),
          )
          .pipe(Effect.scoped);
      }).pipe(Effect.provide(podman(calls)));
      const started = calls.filter(([, command]) => command === "run");
      assert.lengthOf(started, 2);
      for (const args of started) {
        assert.strictEqual(args[args.indexOf("--workdir") + 1], workspace);
        assert.include(args, bindMount(workspace, workspace, "readonly"));
      }
      const withSource = started[1] ?? [];
      assert.strictEqual(
        withSource[withSource.indexOf(bindMount(tree, `${workspace}/acme/demo`, "readonly")) - 1],
        "--mount",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("logs each release of a conversation, and whether its container was removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const directory = `${root}/conversations/${directoryName("supervisor:c1")}`;
      const released: Array<readonly [string, unknown]> = [];
      const recording = Logger.layer([
        Logger.make<unknown, void>(({ logLevel, message }) => {
          if (!Array.isArray(message)) return;
          const [text, fields] = message;
          if (
            String(text).startsWith("Released a supervisor conversation") ||
            String(text).startsWith("Kept the hold")
          )
            released.push([logLevel, [text, fields]]);
        }),
      ]);
      const turns = (removes: boolean) =>
        Effect.gen(function* () {
          const sandbox = yield* sandboxAt(root);
          yield* sandbox.open(codexTurn("supervisor:c1")).pipe(Effect.scoped);
          if (!removes) {
            const refused = yield* sandbox
              .open(codexTurn("supervisor:c1"))
              .pipe(Effect.scoped, Effect.flip);
            assert.include(refused.message, "container remains");
          }
        }).pipe(Effect.provide([podman([], [], { starts: true }, removes), recording]));
      yield* turns(true);
      yield* turns(false);
      const fields = (container: string) => ({
        conversation: "supervisor:c1",
        directory,
        container,
      });
      assert.deepStrictEqual(released[0], [
        "Info",
        ["Released a supervisor conversation", fields("removed")],
      ]);
      assert.isTrue(released.slice(1).every(([level]) => level === "Error"));
      assert.lengthOf(released, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("bounds container startup and removes a container created before the timeout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-start-timeout-" });
      const calls: Array<ReadonlyArray<string>> = [];
      const runtime = { starts: true, hangStart: true };
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        const pending = yield* sandbox
          .open(codexTurn("hung"))
          .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => calls.some(([, command]) => command === "run") }),
          ),
        );
        yield* TestClock.adjust("30 seconds");
        const failure = yield* Fiber.join(pending);
        assert.include(failure.message, "start the supervisor sandbox");
        assert.isTrue(calls.some(([, command]) => command === "rm"));
        const pull = calls.findIndex(([, command]) => command === "pull");
        assert.isBelow(
          pull,
          calls.findIndex(([, command]) => command === "run"),
        );
        runtime.hangStart = false;
        yield* sandbox.open(codexTurn("hung")).pipe(Effect.scoped);
      }).pipe(Effect.provide(podman(calls, [], runtime)));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.live("refuses a runtime that ignores resource limits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-unlimited-" });
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        const failure = yield* sandbox
          .open(codexTurn("unlimited"))
          .pipe(Effect.scoped, Effect.flip);
        assert.include(failure.message, "did not enforce");
      }).pipe(Effect.provide(podman([], [], { starts: true, rejectLimits: true })));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("ends a turn whose model relay doesn't start within 30 seconds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-supervisor-" });
      const calls: Array<ReadonlyArray<string>> = [];
      const relay = { starts: false };
      yield* Effect.gen(function* () {
        const sandbox = yield* sandboxAt(root);
        const turn = yield* sandbox
          .open(codexTurn("supervisor:c1"))
          .pipe(Effect.scoped, Effect.flip, Effect.forkChild);
        // The sandbox starts on the host's clock; its relay's wait runs on the test clock.
        yield* TestClock.withLive(
          Effect.sleep("10 millis").pipe(
            Effect.repeat({
              until: () => calls.some(([, command]) => command === "exec"),
            }),
          ),
        );
        yield* TestClock.adjust("30 seconds");
        const failure = yield* Fiber.join(turn);
        assert.strictEqual(
          failure.message,
          "The supervisor sandbox's model relay didn't start within 30 seconds",
        );
        assert.isAbove(
          calls.filter(([, command]) => command === "exec").length,
          1,
          "the probe retries until the timeout",
        );
        const started = calls.filter(([, command]) => command === "run");
        const removed = calls.filter(([, command]) => command === "rm");
        assert.deepStrictEqual(
          removed.map(([, , , name]) => name),
          started.map((args) => args[args.indexOf("--name") + 1]),
        );
        // The failed turn released the conversation, so its next turn opens.
        relay.starts = true;
        yield* sandbox.open(codexTurn("supervisor:c1")).pipe(Effect.scoped);
      }).pipe(Effect.provide(podman(calls, [], relay)));
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});

describe("the supervisor model relay", () => {
  const relay = (request: Request, route: GatewayModelRoute) =>
    relayModelRequest(route, ModelId.make("m")).pipe(
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
          body: '{"model":"m"}',
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
            body: '{"model":"m"}',
          }),
          new Request("http://127.0.0.1:8787/v1/messages", {
            method: "POST",
            body: '{"model":"m"}',
          }),
          new Request("http://127.0.0.1:8787/anthropic-messages/v1/messages", {
            method: "POST",
            body: '{"model":"m"}',
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

  it.live(
    "separates repository identities, checks fetched objects and removes absolute links",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "usine-source-safety-" });
        const origin = yield* originRepository();
        yield* fs.symlink("/etc/passwd", `${origin.directory}/absolute`);
        yield* fs.symlink("README.md", `${origin.directory}/relative`);
        yield* git(origin.directory, "add", ".");
        yield* git(origin.directory, "commit", "-qm", "links");
        const commands: Array<ReadonlyArray<string>> = [];
        const audited = ChildProcessSpawner.make((command) => {
          assert(command._tag === "StandardCommand");
          commands.push(command.args);
          return native.spawn(command);
        });
        const sources = yield* makeSupervisorSources(root, origin.origin).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, audited),
        );
        const trees = yield* sources.prepare([
          RepositoryName.make("a/b_c"),
          RepositoryName.make("a_b/c"),
        ]);
        assert.strictEqual(new Set(trees.map((tree) => tree.directory)).size, 2);
        for (const tree of trees) {
          const absolute = yield* fs.exists(`${tree.directory}/absolute`);
          const relative = yield* fs.readLink(`${tree.directory}/relative`);
          assert.isFalse(absolute);
          assert.strictEqual(relative, "README.md");
        }
        assert.isTrue(
          commands
            .filter((args) => args.includes("fetch"))
            .every((args) => args.includes("transfer.fsckObjects=true")),
        );
        for (const repository of ["a/.", "a/.."]) {
          const failed = yield* sources
            .prepare([RepositoryName.make(repository)])
            .pipe(Effect.flip);
          assert.include(failed.message, "path segment");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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

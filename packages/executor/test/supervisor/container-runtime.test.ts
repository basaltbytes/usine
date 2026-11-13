import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { remoteCommandLine } from "@usine/agents/child-host";
import { SandboxRequest, SupervisorSandbox, SupervisorSource } from "@usine/agents/supervisor";
import { Harness } from "@usine/core/agent/brain";
import { AgentSessionId } from "@usine/core/agent/session";
import { CommitSha, RepositoryName } from "@usine/core/repository";
import { ContainerImage } from "@usine/core/worker";
import { Effect, FileSystem, Option, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { env } from "node:process";
import { ContainerRuntime } from "../../src/remote/runtime.ts";
import type { GatewayModelRoute } from "../../src/ssh/gateway/model-route.ts";
import { containerSandboxLayer, MODEL_RELAY_PORT } from "../../src/supervisor/container.ts";

/**
 * The container runtime that this suite runs real sandboxes on. CI sets it; without it, the suite
 * is skipped, as on a host without a container runtime.
 */
const runtime = Schema.decodeUnknownOption(ContainerRuntime)(env.USINE_SANDBOX_TEST_RUNTIME);
/** The runtime that a test which runs at all runs on. */
const selected = Option.getOrElse(runtime, (): ContainerRuntime => "docker");
const image = ContainerImage.make(env.USINE_SANDBOX_TEST_IMAGE ?? "docker.io/library/node:22-slim");

const SECRET = "instance-secret-7431";
const REVISION = CommitSha.make("0123456789abcdef0123456789abcdef01234567");

describe.skipIf(Option.isNone(runtime))(
  "the supervisor sandbox on a real container runtime",
  () => {
    it.live(
      "reads the source, but can't write it, read the instance folder, or reach another host",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          // An instance folder outside the system's temporary directory, as on a real host: the
          // container mounts its own empty /tmp.
          const instance = yield* fs.makeTempDirectoryScoped({
            directory: homedir(),
            prefix: "usine-instance-",
          });
          yield* fs.writeFileString(`${instance}/usine.db`, SECRET);
          const tree = `${instance}/supervisor/trees/acme_demo/${REVISION}`;
          yield* fs.makeDirectory(tree, { recursive: true });
          yield* fs.writeFileString(`${tree}/README.md`, "The code word is HERON-2207.\n");
          const relayed: Array<{
            readonly body: string;
            readonly headers: Record<string, string>;
          }> = [];
          const route: GatewayModelRoute = {
            credential: () => Effect.succeedSome("api-key"),
            request: (_protocol, body, headers) =>
              Effect.sync(() => {
                relayed.push({ body, headers: { ...headers } });
                return new Response(`relayed ${body}`, { status: 200 });
              }),
          };
          const conversation = AgentSessionId.make("supervisor:conversation-1");
          const containerName = yield* Effect.gen(function* () {
            const sandbox = yield* SupervisorSandbox;
            assert.deepStrictEqual(sandbox.unavailable, Option.none());
            const seat = yield* sandbox.open(
              SandboxRequest.make({
                conversation,
                harness: Harness.make("claude"),
                sources: [
                  SupervisorSource.make({
                    repository: RepositoryName.make("acme/demo"),
                    revision: REVISION,
                    directory: tree,
                  }),
                ],
              }),
            );
            assert.strictEqual(seat.credential, "gateway-api-key");
            assert.deepStrictEqual(seat.environment, {
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${MODEL_RELAY_PORT}/anthropic-messages`,
              ANTHROPIC_AUTH_TOKEN: "usine-supervisor-sandbox",
            });
            const host = seat.host;
            assert(host._tag === "ExecShell" && host.container !== undefined);
            /** Runs `script` with the sandbox's shell in the session's directory. */
            const sh = (script: string) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const started = yield* host.transport.run(
                    remoteCommandLine(host, {
                      cwd: seat.cwd,
                      environment: {},
                      command: "sh",
                      args: ["-c", script],
                    }),
                    Stream.empty,
                  );
                  const [stdout, stderr] = yield* Effect.all(
                    [
                      started.stdout.pipe(Stream.decodeText(), Stream.mkString),
                      started.stderr.pipe(Stream.decodeText(), Stream.mkString),
                    ],
                    { concurrency: "unbounded" },
                  );
                  return { stdout, stderr, exitCode: yield* started.exitCode };
                }),
              );

            const read = yield* sh("cat acme/demo/README.md");
            assert.deepStrictEqual(
              [read.exitCode, read.stdout],
              [0, "The code word is HERON-2207.\n"],
            );
            for (const write of [
              "echo changed > acme/demo/README.md",
              "touch acme/demo/new-file",
              "touch new-repository",
              // The relay's socket stays the orchestrator's, so the container ends without it.
              "touch /run/usine/model.sock.new",
            ]) {
              const written = yield* sh(write);
              assert.notStrictEqual(written.exitCode, 0, `${write} fails`);
              assert.include(written.stderr, "Read-only file system", write);
            }
            const rootMount = yield* sh(
              'while read -r device point type options rest; do [ "$point" = / ] && echo "$options"; done < /proc/mounts',
            );
            assert.match(rootMount.stdout.trim(), /^ro(,|$)/u, "the root file system is read-only");
            // The container's main process holds no capability and can't gain privileges.
            const status = yield* sh("grep -E '^(CapEff|CapBnd|NoNewPrivs):' /proc/1/status");
            assert.strictEqual(status.exitCode, 0, status.stderr);
            assert.match(status.stdout, /^CapEff:\s+0+$/mu);
            assert.match(status.stdout, /^CapBnd:\s+0+$/mu);
            assert.match(status.stdout, /^NoNewPrivs:\s+1$/mu);

            const unchanged = yield* fs.readFileString(`${tree}/README.md`);
            assert.strictEqual(unchanged, "The code word is HERON-2207.\n");

            const instanceFile = yield* sh(`cat '${instance}/usine.db'`);
            assert.notStrictEqual(instanceFile.exitCode, 0);
            assert.notInclude(instanceFile.stdout, SECRET);
            assert.include(instanceFile.stderr, "No such file or directory");
            const listing = yield* sh(`ls -A '${instance}'`);
            assert.notInclude(listing.stdout, "usine.db", "the instance folder isn't mounted");

            const connect = (address: string, port: number) =>
              sh(
                `node -e 'require("node:net").connect(${port}, "${address}").on("connect", () => process.exit(0)).on("error", (error) => { console.error(error.code); process.exit(3); })'`,
              );
            for (const [address, port] of [
              ["1.1.1.1", 443],
              ["github.com", 443],
              ["host.docker.internal", 80],
            ] as const) {
              const reached = yield* connect(address, port);
              assert.strictEqual(reached.exitCode, 3, `${address} is unreachable`);
            }

            const model = yield* sh(
              `node -e 'fetch("http://127.0.0.1:${MODEL_RELAY_PORT}/anthropic-messages/v1/messages", { method: "POST", body: "hello", headers: { authorization: "Bearer usine-supervisor-sandbox", "anthropic-version": "2023-06-01" } }).then(async (response) => console.log(response.status, await response.text()))'`,
            );
            assert.deepStrictEqual([model.exitCode, model.stdout.trim()], [0, "200 relayed hello"]);
            assert.strictEqual(relayed[0]?.headers["anthropic-version"], "2023-06-01");
            assert.notProperty(relayed[0]?.headers, "authorization");
            const token = yield* sh(
              `node -e 'fetch("http://127.0.0.1:${MODEL_RELAY_PORT}/anthropic-messages/v1/messages", { method: "POST", body: "again", headers: { "x-usine-gateway-token": "ugw1.chosen.by-the-session" } }).then((response) => console.log(response.status))'`,
            );
            assert.strictEqual(token.stdout.trim(), "200");
            assert.notProperty(relayed[1]?.headers, "x-usine-gateway-token");

            const home = yield* sh('touch "$HOME/saved-session" && echo "$HOME"');
            assert.strictEqual(home.exitCode, 0);
            const saved = yield* fs.exists(`${home.stdout.trim()}/saved-session`);
            assert.isTrue(saved, "the conversation's home stays on the orchestrator");
            return host.container.name;
          }).pipe(
            Effect.scoped,
            Effect.provide(
              containerSandboxLayer({
                root: `${instance}/supervisor`,
                image,
                runtime,
                route: Option.some(Effect.succeed(route)),
              }),
            ),
          );
          const left = yield* spawner.string(
            ChildProcess.make(selected, [
              "ps",
              "--all",
              "--quiet",
              "--filter",
              `name=${containerName}`,
            ]),
          );
          assert.strictEqual(left.trim(), "", "closing the turn removes its sandbox");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      180_000,
    );

    it.live(
      "ends a sandbox whose orchestrator no longer serves its model relay",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const instance = yield* fs.makeTempDirectoryScoped({
            directory: homedir(),
            prefix: "usine-instance-",
          });
          const route: GatewayModelRoute = {
            credential: () => Effect.succeedNone,
            request: () => Effect.die("the test calls no model"),
          };
          const running = (name: string) =>
            spawner
              .string(
                ChildProcess.make(selected, ["ps", "--all", "--quiet", "--filter", `name=${name}`]),
              )
              .pipe(Effect.map((listed) => listed.trim() !== ""));
          yield* Effect.gen(function* () {
            const sandbox = yield* SupervisorSandbox;
            const seat = yield* sandbox.open(
              SandboxRequest.make({
                conversation: AgentSessionId.make("supervisor:conversation-2"),
                harness: Harness.make("claude"),
                sources: [],
              }),
            );
            const host = seat.host;
            assert(host._tag === "ExecShell" && host.container !== undefined);
            const name = host.container.name;
            const relayDirectory = yield* spawner.string(
              ChildProcess.make(selected, [
                "inspect",
                "--format",
                '{{range .Mounts}}{{if eq .Destination "/run/usine"}}{{.Source}}{{end}}{{end}}',
                name,
              ]),
            );
            // As after the orchestrator stops: the relay's socket no longer accepts connections.
            yield* fs.remove(`${relayDirectory.trim()}/model.sock`);
            const stillRunning = yield* running(name).pipe(
              Effect.repeat({ while: (alive) => alive, schedule: Schedule.spaced("1 second") }),
              Effect.timeout("30 seconds"),
            );
            assert.isFalse(stillRunning, "the sandbox ends and removes itself");
          }).pipe(
            Effect.scoped,
            Effect.provide(
              containerSandboxLayer({
                root: `${instance}/supervisor`,
                image,
                runtime,
                route: Option.some(Effect.succeed(route)),
              }),
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      180_000,
    );
  },
);

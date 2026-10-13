import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { childPidFile, type RemoteShell, sshArguments } from "@usine/agents/child-host";
import { UsineConfig } from "@usine/config/factory";
import { Agent, AgentName, AgentPersona } from "@usine/core/agent";
import { BrainSpec, type Harness, ModelId } from "@usine/core/agent/brain";
import { HarnessReady } from "@usine/core/agent/capability";
import { AgentSessionId } from "@usine/core/agent/session";
import { AttemptTask } from "@usine/core/attempt";
import { DedupKey, Event, EventId } from "@usine/core/event";
import { InstanceDirectory } from "@usine/core/instance";
import { ItemKey } from "@usine/core/item";
import { LoopName } from "@usine/core/loop";
import { RepositoryName, RepositoryRevision, safeSegment } from "@usine/core/repository";
import { StepName } from "@usine/core/step";
import { WorkerName } from "@usine/core/worker";
import { type StubParent, stubAttemptRuntime, StubStorage } from "@usine/durable/testing";
import { RunEngine, Submission } from "@usine/engine/engine";
import { CredentialProvider, CredentialUnavailableError, Executor } from "@usine/executor";
import { layer as sshExecutorLayer } from "@usine/executor/ssh";
import { GitHubApp } from "@usine/github/github-app";
import { localSecretsLayer } from "@usine/github/local-secrets";
import { Config, DateTime, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { gitHubCredentialLayer } from "../../src/credentials.ts";
import { layer as sshLayer, sshWorkersOf } from "../../src/ssh.ts";
import { alwaysHoldsLayer } from "../support/polling.ts";

// The machine is named by the environment; without it there is nothing to run against.
const destination = process.env.USINE_SSH_INTEGRATION_DESTINATION;
const WORKER = WorkerName.make("ssh-integration");
const PLAIN_SSH = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=4",
];

const settings = Effect.all({
  destination: Config.string("USINE_SSH_INTEGRATION_DESTINATION"),
  root: Config.string("USINE_SSH_INTEGRATION_ROOT").pipe(Config.withDefault("/home/usine/.usine")),
  identityFile: Config.option(Config.string("USINE_SSH_INTEGRATION_IDENTITY_FILE")),
  port: Config.option(Config.int("USINE_SSH_INTEGRATION_PORT")),
  knownHosts: Config.option(Config.string("USINE_SSH_INTEGRATION_KNOWN_HOSTS")),
  repository: Config.string("USINE_SSH_INTEGRATION_REPO"),
  revision: Config.string("USINE_SSH_INTEGRATION_REVISION").pipe(Config.withDefault("main")),
  credentialsDirectory: Config.string("USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY"),
});

const configFor = (values: Effect.Success<typeof settings>) =>
  Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: values.repository }],
    workers: [
      {
        name: WORKER,
        kind: "ssh",
        destination: values.destination,
        root: values.root,
        max_concurrent_attempts: 1,
        ...Option.match(values.identityFile, {
          onNone: () => ({}),
          onSome: (file) => ({ identity_file: file }),
        }),
        ...Option.match(values.port, { onNone: () => ({}), onSome: (port) => ({ port }) }),
      },
    ],
  });

/** The shared SSH options, with a separate known-hosts file when one is given. */
const sshFor = (values: Effect.Success<typeof settings>) => ({
  command: "ssh",
  args: [
    ...PLAIN_SSH,
    ...Option.match(values.knownHosts, {
      onNone: () => [],
      onSome: (file) => ["-o", `UserKnownHostsFile=${file}`],
    }),
  ],
});

const brain = (harness: Harness, model: string) =>
  new BrainSpec({ harness, model: ModelId.make(model), effort: "low" });

const agent = new Agent({
  name: AgentName.make("developer"),
  brain: brain("claude", "claude-sonnet-4-6"),
  parentModel: Option.none(),
  parentEffort: Option.none(),
  persona: AgentPersona.make("Verify the SSH Worker transport."),
});

/** Runs one command on the machine through `host`, as an Attempt's child would, and returns its exit code and output. */
const onMachine = Effect.fn("SshIntegration.onMachine")(function* (
  host: RemoteShell,
  invocation: Parameters<typeof sshArguments>[1],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(host.ssh.command, sshArguments(host, invocation), {
          env: { ...host.sshEnvironment },
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
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: Number(exitCode) };
    }),
  );
});

const succeeds = Effect.fn("SshIntegration.succeeds")(function* (
  host: RemoteShell,
  invocation: Parameters<typeof sshArguments>[1],
) {
  const result = yield* onMachine(host, invocation);
  if (result.exitCode !== 0)
    return yield* Effect.die(
      `${invocation.command} ${invocation.args.join(" ")} exited ${result.exitCode}: ${result.stderr}`,
    );
  return result.stdout;
});

/** What the scripted parent saw on the machine while the Attempt ran. */
interface Observed {
  host?: RemoteShell;
  worktree?: string;
  ghRepository?: string;
  advertisedHead?: string;
  credentialModes?: string;
  childPid?: string;
}

const waitForTerminal = Effect.fn("SshIntegration.waitForTerminal")(function* (
  engine: RunEngine["Service"],
  runId: Parameters<RunEngine["Service"]["inspect"]>[0],
) {
  for (let poll = 0; poll < 3_000; poll += 1) {
    const snapshot = yield* engine.inspect(runId);
    if (["Succeeded", "Failed", "Canceled"].includes(snapshot.run.state._tag)) return snapshot;
    yield* Effect.sleep("100 millis");
  }
  return yield* Effect.die("The SSH integration Run did not finish within five minutes");
});

describe.skipIf(destination === undefined)("live SSH Worker", () => {
  it.live(
    "runs one Attempt on the machine with a minted token and leaves no checkout, credential, or child behind",
    () =>
      Effect.gen(function* () {
        const values = yield* settings;
        const config = configFor(values);
        const repository = RepositoryName.make(values.repository);
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceDirectory = InstanceDirectory.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-ssh-integration-" }),
        );
        const observed: Observed = {};
        // Does what a child does on the machine: uses gh and git with the
        // Attempt's credential, commits, and leaves a long-running process
        // whose SSH client this parent then drops.
        const parent: StubParent = ({ request }) =>
          Effect.gen(function* () {
            const host = request.host;
            if (host._tag !== "RemoteShell")
              return yield* Effect.die("expected a remote child host");
            observed.host = host;
            observed.worktree = request.cwd;
            const inWorktree = { cwd: request.cwd, environment: request.environment };
            const credentials = request.environment.GH_CONFIG_DIR ?? "";
            observed.credentialModes = yield* succeeds(host, {
              command: "stat",
              args: ["-c", "%a", credentials, `${credentials}/token`, `${credentials}/hosts.yml`],
            });
            observed.ghRepository = yield* succeeds(host, {
              ...inWorktree,
              command: "gh",
              args: ["api", `repos/${repository}`, "--jq", ".full_name"],
            });
            observed.advertisedHead = yield* succeeds(host, {
              ...inWorktree,
              command: "git",
              args: ["ls-remote", "origin", "HEAD"],
            });
            yield* succeeds(host, {
              ...inWorktree,
              command: "git",
              args: [
                "-c",
                "user.name=usine",
                "-c",
                "user.email=usine@basaltbytes.dev",
                "commit",
                "--allow-empty",
                "-m",
                "ssh worker integration",
              ],
            });
            const pidFile = childPidFile(
              request.cwd,
              AgentSessionId.make(`child:${request.spec.attemptId}:1`),
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                yield* spawner.spawn(
                  ChildProcess.make(
                    host.ssh.command,
                    sshArguments(host, { ...inWorktree, pidFile, command: "sleep", args: ["600"] }),
                    { env: { ...host.sshEnvironment }, extendEnv: false },
                  ),
                );
                for (let poll = 0; poll < 100 && observed.childPid === undefined; poll += 1) {
                  const read = yield* onMachine(host, { command: "cat", args: [pidFile] });
                  if (read.exitCode === 0 && read.stdout !== "") observed.childPid = read.stdout;
                  else yield* Effect.sleep("100 millis");
                }
              }),
            );
            return "The SSH Worker ran the Attempt's commands";
          }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

        const app = GitHubApp.layer.pipe(
          Layer.provide(
            localSecretsLayer(InstanceDirectory.make(values.credentialsDirectory)).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provide(FetchHttpClient.layer),
        );
        const runtime = sshLayer(instanceDirectory, config, [agent.brain], {
          workers: sshWorkersOf(config),
          ssh: sshFor(values),
          // Logins are the operator's; this test needs none, the preflight test checks them.
          harnessReadiness: () => (brain) =>
            Effect.succeed(new HarnessReady({ harness: brain.harness })),
        }).pipe(
          Layer.provide(gitHubCredentialLayer(config).pipe(Layer.provide(app))),
          Layer.provide(alwaysHoldsLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage(), parent)),
        );

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(
            new Submission({
              event: new Event({
                id: EventId.make(`ssh-${globalThis.crypto.randomUUID()}`),
                dedupKey: DedupKey.make(`ssh/${repository}/${globalThis.crypto.randomUUID()}`),
                payload: { integration: "ssh" },
                receivedAt: yield* DateTime.now,
              }),
              itemKey: ItemKey.make("ssh-integration"),
              loop: LoopName.make("ssh-integration"),
              step: StepName.make("execute"),
              approval: "none",
              repository,
              revision: RepositoryRevision.make(values.revision),
              task: AttemptTask.make("Verify the SSH Worker transport"),
              agent,
              parentModel: Option.none(),
            }),
          );
          assert.strictEqual(accepted._tag, "Claimed");
          if (accepted._tag !== "Claimed") return;
          const finished = yield* waitForTerminal(engine, accepted.runId);
          const attempt = finished.attempts[0];
          assert(attempt !== undefined);
          assert.strictEqual(
            finished.run.state._tag,
            "Succeeded",
            JSON.stringify(Option.getOrNull(attempt.outcome)),
          );
          assert.strictEqual(attempt.worker, WORKER);
          assert.strictEqual(observed.ghRepository, repository);
          assert.match(observed.advertisedHead ?? "", /^[0-9a-f]{40}\tHEAD$/u);
          assert.match(observed.childPid ?? "", /^[0-9]+$/u);
          assert.strictEqual(
            observed.credentialModes,
            "700\n600\n600",
            "only the SSH user can read the Attempt's credential",
          );
          const facts = Option.match(finished.step.result, {
            onNone: () => [],
            onSome: (result) => result.facts,
          });
          assert(
            facts.some(
              (fact) => fact._tag === "Commit" && fact.summary === "ssh worker integration",
            ),
            "the harvest must report the commit made on the machine",
          );

          const host = observed.host;
          assert(host !== undefined);
          const root = `${values.root}/workers/${safeSegment(WORKER)}`;
          const worktree = `${root}/attempts/${safeSegment(attempt.id)}`;
          assert.strictEqual(observed.worktree, worktree);
          const absent = (path: string) =>
            onMachine(host, { command: "test", args: ["!", "-e", path] });
          assert.strictEqual(
            (yield* onMachine(host, {
              command: "test",
              args: ["-d", `${root}/repos/${safeSegment(repository)}.git`],
            })).exitCode,
            0,
            "the cached clone stays for the next Attempt",
          );
          assert.strictEqual((yield* absent(worktree)).exitCode, 0, "the worktree is removed");
          assert.strictEqual(
            (yield* absent(`${root}/credentials/${safeSegment(attempt.id)}`)).exitCode,
            0,
            "the Attempt's credential is removed",
          );
          assert.strictEqual(
            (yield* absent(`${worktree}.child-1.pid`)).exitCode,
            0,
            "the child's pid file is removed",
          );
          assert.notStrictEqual(
            (yield* onMachine(host, { command: "kill", args: ["-0", observed.childPid ?? ""] }))
              .exitCode,
            0,
            "the child that outlived its SSH client is stopped",
          );
        }).pipe(Effect.provide(runtime));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    { timeout: 300_000 },
  );

  it.live(
    "preflight finds Git and both harnesses installed where children run",
    () =>
      Effect.gen(function* () {
        const values = yield* settings;
        const config = configFor(values);
        const unused = Layer.succeed(CredentialProvider)({
          issue: (repository) =>
            Effect.fail(
              new CredentialUnavailableError({
                repository,
                message: "Preflight issues no credential",
                cause: new Error("unused"),
              }),
            ),
        });
        const executor = sshExecutorLayer({
          workers: sshWorkersOf(config),
          ssh: sshFor(values),
        }).pipe(
          Layer.provide(unused),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          const ssh = yield* Executor;
          yield* ssh.preflight(WORKER, []);
          for (const checked of [
            brain("claude", "claude-sonnet-4-6"),
            brain("codex", "gpt-5.6-sol"),
          ]) {
            const outcome = yield* ssh.preflight(WORKER, [checked]).pipe(Effect.result);
            // A Worker nobody logged in to yet has the harness but not its login.
            if (outcome._tag === "Failure") {
              assert(outcome.failure._tag === "WorkerCapabilityError", outcome.failure.message);
              assert.strictEqual(
                outcome.failure.capability,
                "harness-login",
                outcome.failure.message,
              );
            }
            yield* Effect.logInfo("SSH Worker harness preflight", {
              harness: checked.harness,
              outcome: outcome._tag === "Success" ? "ready" : outcome.failure.message,
            });
          }
        }).pipe(Effect.provide(executor));
      }),
    { timeout: 120_000 },
  );
});

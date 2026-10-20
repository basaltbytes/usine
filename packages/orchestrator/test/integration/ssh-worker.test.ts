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
import { GatewayAdminApi } from "@usine/gateway/admin";
import { GitHubApp } from "@usine/github/github-app";
import { localSecretsLayer } from "@usine/github/local-secrets";
import {
  Config,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { gitHubCredentialLayer } from "../../src/credentials.ts";
import { layer as sshLayer, sshWorkerAddressesOf } from "../../src/ssh.ts";
import { fixedConfigLayer } from "../support/current-instance.ts";
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
              args: [
                "-c",
                "%a",
                `${credentials}/..`,
                credentials,
                `${credentials}/token`,
                `${credentials}/hosts.yml`,
              ],
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
          workers: yield* sshWorkerAddressesOf(config),
          ssh: sshFor(values),
          // Logins are the operator's; this test needs none, the preflight test checks them.
          harnessReadiness: () => (brain) =>
            Effect.succeed(new HarnessReady({ harness: brain.harness })),
        }).pipe(
          Layer.provide(gitHubCredentialLayer.pipe(Layer.provide(app))),
          Layer.provide(alwaysHoldsLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage(), parent)),
          Layer.provide(fixedConfigLayer(config)),
          Layer.provide(app),
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
            "700\n700\n600\n600",
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
                reason: "refused",
                message: "Preflight issues no credential",
                cause: new Error("unused"),
              }),
            ),
        });
        const executor = sshExecutorLayer({
          workers: yield* sshWorkerAddressesOf(config),
          ssh: sshFor(values),
        }).pipe(
          Layer.provide(unused),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(NodeServices.layer),
          Layer.provide(FetchHttpClient.layer),
        );
        yield* Effect.gen(function* () {
          const ssh = yield* Executor;
          yield* ssh.preflight(WORKER, [], 1);
          for (const checked of [
            brain("claude", "claude-sonnet-4-6"),
            brain("codex", "gpt-5.6-sol"),
          ]) {
            const outcome = yield* ssh.preflight(WORKER, [checked], 1).pipe(Effect.result);
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

// A Worker behind a Gateway is named by these; without them the Gateway case is skipped.
const gatewayDestination = process.env.USINE_GATEWAY_INTEGRATION_DESTINATION;
const GATEWAY_WORKER = WorkerName.make("gateway-integration");

const gatewaySettings = Effect.all({
  destination: Config.string("USINE_GATEWAY_INTEGRATION_DESTINATION"),
  sshConfig: Config.option(Config.string("USINE_GATEWAY_INTEGRATION_SSH_CONFIG")),
  root: Config.string("USINE_GATEWAY_INTEGRATION_ROOT").pipe(
    Config.withDefault("/home/usine/.usine"),
  ),
  domain: Config.string("USINE_GATEWAY_INTEGRATION_DOMAIN").pipe(Config.withDefault("gw.internal")),
  gateway: Config.string("USINE_GATEWAY_INTEGRATION_GATEWAY").pipe(
    Config.withDefault("usine-gateway"),
  ),
  repository: Config.string("USINE_GATEWAY_INTEGRATION_REPO"),
  revision: Config.string("USINE_GATEWAY_INTEGRATION_REVISION").pipe(Config.withDefault("main")),
  credentialsDirectory: Config.string("USINE_GITHUB_INTEGRATION_INSTANCE_DIRECTORY"),
});

/** The Worker behind the Gateway, with no `llm_providers`: its harnesses use their logins on the machine. */
const gatewayConfigFor = (values: Effect.Success<typeof gatewaySettings>) =>
  Schema.decodeUnknownSync(UsineConfig)({
    version: 1,
    repos: [{ name: values.repository }],
    workers: [
      {
        name: GATEWAY_WORKER,
        kind: "ssh",
        destination: values.destination,
        root: values.root,
        gateway: {
          domain: values.domain,
          destination: values.gateway,
          admin_token_env: "USINE_GATEWAY_INTEGRATION_ADMIN_TOKEN",
        },
      },
    ],
  });

/** The shared SSH options, with the SSH configuration that names the Worker and its bastion when one is given. */
const gatewaySshFor = (values: Effect.Success<typeof gatewaySettings>) => ({
  command: "ssh",
  args: [
    ...PLAIN_SSH,
    ...Option.match(values.sshConfig, {
      onNone: () => [],
      onSome: (file) => ["-F", file],
    }),
  ],
});

/** The local port of the test's own forward to the admin API, which checks the Gateway after the Attempt. */
const CHECK_PORT = 17070;

/**
 * The attachments the Gateway holds, listed through a forward the test opens
 * itself with the Worker's SSH options, separate from the executor's.
 */
const gatewayAttachments = Effect.fn("GatewayIntegration.attachments")(function* (
  values: Effect.Success<typeof gatewaySettings>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* spawner.spawn(
    ChildProcess.make(
      "ssh",
      [
        ...gatewaySshFor(values).args,
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `127.0.0.1:${String(CHECK_PORT)}:127.0.0.1:7070`,
        values.gateway,
      ],
      { detached: false, forceKillAfter: "5 seconds", stdin: "ignore" },
    ),
  );
  const admin = yield* HttpApiClient.make(GatewayAdminApi, {
    baseUrl: `http://127.0.0.1:${String(CHECK_PORT)}`,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(
        yield* Config.redacted("USINE_GATEWAY_INTEGRATION_ADMIN_TOKEN"),
      ),
    ),
  });
  // The forward listens once its SSH connection is up.
  return yield* admin.attachments
    .list()
    .pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }));
});

/** What the scripted parent saw on a Worker behind a Gateway. */
interface ObservedBehindGateway {
  host?: RemoteShell;
  callerTokenFormat?: string;
  advertisedHead?: string;
  ghRepository?: string;
  pushedBranch?: string;
  deletedThroughGitHubUrl?: string;
  registryStatus?: string;
  proxyHostAaaa?: string;
  tokensOnMachine?: string;
}

describe.skipIf(gatewayDestination === undefined)("live SSH Worker behind a Gateway", () => {
  it.live(
    "runs one Attempt with only a caller token on the machine: git and gh reach GitHub through the Gateway, and the attachment is gone afterwards",
    () =>
      Effect.gen(function* () {
        const values = yield* gatewaySettings;
        const config = gatewayConfigFor(values);
        const repository = RepositoryName.make(values.repository);
        const branch = `usine-gateway-test/${globalThis.crypto.randomUUID()}`;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceDirectory = InstanceDirectory.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "usine-gateway-integration-" }),
        );
        const observed: ObservedBehindGateway = {};
        // Does what a child does on the machine, with only the Attempt's
        // child host and environment: git through the Gateway (fetch, push to
        // the gateway remote, delete through a github.com URL), gh through
        // its socket, a package registry through the forward proxy, an AAAA
        // lookup of the proxy's name, and a scan of the machine for GitHub
        // tokens.
        const parent: StubParent = ({ request }) =>
          Effect.gen(function* () {
            const host = request.host;
            if (host._tag !== "RemoteShell")
              return yield* Effect.die("expected a remote child host");
            observed.host = host;
            const inWorktree = { cwd: request.cwd, environment: request.environment };
            observed.callerTokenFormat = yield* succeeds(host, {
              ...inWorktree,
              command: "sh",
              args: ["-c", 'printf %s "${GH_ENTERPRISE_TOKEN%%.*}"'],
            });
            observed.advertisedHead = yield* succeeds(host, {
              ...inWorktree,
              command: "git",
              args: ["ls-remote", "origin", "HEAD"],
            });
            observed.ghRepository = yield* succeeds(host, {
              ...inWorktree,
              command: "gh",
              args: ["api", `repos/${repository}`, "--jq", ".full_name"],
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
                "gateway worker integration",
              ],
            });
            yield* succeeds(host, {
              ...inWorktree,
              command: "git",
              args: ["push", "origin", `HEAD:refs/heads/${branch}`],
            });
            observed.pushedBranch = yield* succeeds(host, {
              ...inWorktree,
              command: "git",
              args: ["ls-remote", "origin", `refs/heads/${branch}`],
            });
            yield* succeeds(host, {
              ...inWorktree,
              command: "git",
              args: ["push", `https://github.com/${repository}.git`, "--delete", branch],
            });
            observed.deletedThroughGitHubUrl = yield* succeeds(host, {
              ...inWorktree,
              command: "git",
              args: ["ls-remote", "origin", `refs/heads/${branch}`],
            });
            observed.registryStatus = yield* succeeds(host, {
              ...inWorktree,
              command: "curl",
              args: ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "https://registry.npmjs.org/"],
            });
            // musl's resolver, which Codex uses, fails the whole lookup of the proxy's name when its AAAA query is refused (#260).
            observed.proxyHostAaaa = yield* succeeds(host, {
              ...inWorktree,
              command: "node",
              args: [
                "-e",
                "require('node:dns').promises.resolve6(process.argv[1]).then(() => console.log('answered'), (error) => console.log(error.code))",
                values.domain,
              ],
            });
            observed.tokensOnMachine = yield* succeeds(host, {
              ...inWorktree,
              command: "sh",
              // Checkouts and cached clones are left out: the repository's own text may contain "ghs_".
              args: [
                "-c",
                'grep -rIl --exclude-dir=repos --exclude-dir=attempts "ghs_" "$HOME" /tmp 2>/dev/null; env | grep -c "ghs_"; true',
              ],
            });
            return "The Worker reached GitHub through its Gateway";
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
          workers: yield* sshWorkerAddressesOf(config),
          ssh: gatewaySshFor(values),
          // The logins are the operator's; the Gateway's check of their hosts still runs.
          harnessReadiness: () => (brain) =>
            Effect.succeed(new HarnessReady({ harness: brain.harness })),
        }).pipe(
          Layer.provide(gitHubCredentialLayer.pipe(Layer.provide(app))),
          Layer.provide(alwaysHoldsLayer),
          Layer.provide(stubAttemptRuntime(new StubStorage(), parent)),
          Layer.provide(fixedConfigLayer(config)),
          Layer.provide(app),
        );

        yield* Effect.gen(function* () {
          const engine = yield* RunEngine;
          const accepted = yield* engine.submit(
            new Submission({
              event: new Event({
                id: EventId.make(`gateway-${globalThis.crypto.randomUUID()}`),
                dedupKey: DedupKey.make(`gateway/${repository}/${globalThis.crypto.randomUUID()}`),
                payload: { integration: "gateway" },
                receivedAt: yield* DateTime.now,
              }),
              itemKey: ItemKey.make("gateway-integration"),
              loop: LoopName.make("gateway-integration"),
              step: StepName.make("execute"),
              approval: "none",
              repository,
              revision: RepositoryRevision.make(values.revision),
              task: AttemptTask.make("Verify the Worker reaches GitHub through its Gateway"),
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
          assert.strictEqual(observed.callerTokenFormat, "ugw1", "the child has a caller token");
          assert.match(observed.advertisedHead ?? "", /^[0-9a-f]{40}\tHEAD$/u);
          assert.strictEqual(observed.ghRepository, repository);
          assert.match(
            observed.pushedBranch ?? "",
            new RegExp(`^[0-9a-f]{40}\trefs/heads/${branch}$`, "u"),
          );
          assert.strictEqual(
            observed.deletedThroughGitHubUrl,
            "",
            "the github.com push went through the Gateway",
          );
          assert.strictEqual(observed.registryStatus, "200");
          assert.oneOf(
            observed.proxyHostAaaa,
            ["answered", "ENODATA"],
            "the Gateway's DNS does not refuse an AAAA query for the proxy's name",
          );
          assert.strictEqual(observed.tokensOnMachine, "0", "no GitHub token on the machine");
          const host = observed.host;
          assert(host !== undefined);
          assert.notInclude(host.ssh.args.join(" "), "ugw1.");

          const { attachments } = yield* gatewayAttachments(values);
          assert.deepStrictEqual(
            attachments.filter(({ worker }) => worker === GATEWAY_WORKER),
            [],
            "the Attempt's attachment is detached",
          );
        }).pipe(Effect.provide(runtime), Effect.provide(FetchHttpClient.layer));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    { timeout: 300_000 },
  );

  it.live(
    "preflight checks both harness logins on the machine, and with a login, its hosts through the forward proxy",
    () =>
      Effect.gen(function* () {
        const values = yield* gatewaySettings;
        const config = gatewayConfigFor(values);
        const unused = Layer.succeed(CredentialProvider)({
          issue: (repository) =>
            Effect.fail(
              new CredentialUnavailableError({
                repository,
                reason: "refused",
                message: "Preflight issues no credential",
                cause: new Error("unused"),
              }),
            ),
        });
        const executor = sshExecutorLayer({
          workers: yield* sshWorkerAddressesOf(config),
          ssh: gatewaySshFor(values),
        }).pipe(
          Layer.provide(unused),
          Layer.provide(stubAttemptRuntime(new StubStorage())),
          Layer.provide(NodeServices.layer),
          Layer.provide(FetchHttpClient.layer),
        );
        yield* Effect.gen(function* () {
          const ssh = yield* Executor;
          for (const checked of [
            brain("claude", "claude-sonnet-4-6"),
            brain("codex", "gpt-5.6-sol"),
          ]) {
            const outcome = yield* ssh.preflight(GATEWAY_WORKER, [checked], 1).pipe(Effect.result);
            // A Worker nobody logged in to yet has the harness but not its login.
            if (outcome._tag === "Failure") {
              assert(outcome.failure._tag === "WorkerCapabilityError", outcome.failure.message);
              assert.strictEqual(
                outcome.failure.capability,
                "harness-login",
                outcome.failure.message,
              );
            }
            yield* Effect.logInfo("SSH Worker behind a Gateway harness preflight", {
              harness: checked.harness,
              outcome: outcome._tag === "Success" ? "ready" : outcome.failure.message,
            });
          }
        }).pipe(Effect.provide(executor));
      }),
    { timeout: 120_000 },
  );
});

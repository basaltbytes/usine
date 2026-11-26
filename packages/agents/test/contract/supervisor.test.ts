import { apiKeys } from "../../src/harness/pool.ts";
import { claudePlan } from "../../src/harness/claude/descriptor.ts";
import { chatgptPlan } from "../../src/harness/codex/descriptor.ts";
import { CodexAppServer } from "../../src/harness/codex/app-server.ts";
import { codexRuntime } from "../../src/harness/codex/codex.ts";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import type { BillingPool } from "@usine/core/agent/pool";
import {
  AgentSessionId,
  type AgentSessionEvent,
  HarnessSession,
  HarnessSessionId,
  RoleSession,
  SessionStarted,
  SessionTokensUpdated,
  TokenCount,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { MessageSizeMib, WorkerName } from "@usine/core/worker";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
  Stream,
} from "effect";
import { ExecShell, LocalProcess } from "../../src/child-host/child-host.ts";
import { AdmissionContext, admitBrain } from "../../src/harness/admission.ts";
import {
  type Capability,
  CapabilityProfile,
  type CredentialRoute,
  Lacking,
  Placement,
} from "../../src/harness/capability.ts";
import { catalog } from "../../src/harness/catalog.ts";
import { claude } from "../../src/harness/claude/descriptor.ts";
import { codex } from "../../src/harness/codex/descriptor.ts";
import { type NativeSession, SessionSpec, StartPrompt } from "../../src/harness/contract.ts";
import { admitSession } from "../../src/harness/launch.ts";
import { HarnessCatalog, HarnessDescriptor } from "../../src/harness/harness.ts";
import { Harnesses } from "../../src/harness/registry.ts";
import type { HarnessRuntime } from "../../src/harness/runtime.ts";
import { admitSupervisor, supervisor, supervisorAgent } from "../../src/harness/supervisor/role.ts";
import {
  runSupervisorTurn,
  SupervisorSeat,
  SupervisorTurn,
} from "../../src/harness/supervisor/turn.ts";
import {
  AgentCapacityError,
  SessionOperationError,
  type AgentSessionError,
  RestartState,
  SessionResult,
  WorkingDirectory,
} from "../../src/runtime.ts";
import { collectLogs } from "../logs.ts";
import { assertProvenCapabilities } from "./capabilities.ts";
import { replayContainerHost } from "./container-seat.ts";
import { isJsonObject, Tape, type Transcript } from "../replay/transcript.ts";
import { remoteCommandLine } from "../../src/child-host/child-host.ts";
import { PROCESS_OWNER } from "../../src/child-host/supervisor.ts";
import {
  operatorToolHandlers,
  operatorTools,
  RESUMED,
  runSupervisorScenario,
  supervisorMessages,
  type SupervisorProvider,
  supervisorProviders,
  WAITING_RUN,
} from "./supervisor.ts";

const container = { runtime: "docker", name: "test-container" };
const seat = SupervisorSeat.make({
  host: Object.assign(
    ExecShell.make({
      destination: "test-container",
      container,
      transport: { run: () => Effect.die("The fake harness does not execute commands") },
    }),
    { container },
  ),
  worker: WorkerName.make("orchestrator"),
  restored: true,
  protocolFrameMib: MessageSizeMib.make(12),
  cwd: WorkingDirectory.make("/tmp"),
  environment: {},
  credential: "gateway",
});

const claudeBrain = BrainSpec.make({
  harness: Harness.make("claude"),
  model: ModelId.make("claude-sonnet-5-5"),
  effort: "low",
});

const conversation = AgentSessionId.make("supervisor:conversation");

/** The supervisor session's cumulative usage of `totalTokens`. */
const spent = (totalTokens: number) =>
  SessionTokensUpdated.make({
    session: RoleSession.make({
      id: conversation,
      role: supervisor.name,
      agent: supervisorAgent,
      brain: claudeBrain,
    }),
    totalTokens: TokenCount.make(totalTokens),
  });

/**
 * A Claude Code runtime whose sessions report `events`, end with `result`, and report `active`;
 * `restored` collects the restart state that each open receives.
 */
const scriptedClaude = (session: {
  readonly events: Stream.Stream<AgentSessionEvent, AgentSessionError>;
  readonly result: Effect.Effect<SessionResult, AgentSessionError>;
  readonly active: boolean;
}) => {
  const restored: Array<RestartState> = [];
  const unused = () => assert.fail("the supervisor turn calls only open");
  const runtime: HarnessRuntime = {
    id: claudeBrain.harness,
    open: (spec, _start, continuation) =>
      Effect.sync((): NativeSession => {
        assert.deepStrictEqual(spec.protocolFrameMib, Option.some(12));
        restored.push(continuation.restored);
        return {
          running: {
            session: spec.session,
            events: session.events,
            result: session.result,
            steer: () => Effect.void,
            interrupt: Effect.void,
            intervene: () =>
              Effect.succeed(AttemptChannel.InterventionState.make({ held: false, paused: false })),
          },
          active: session.active,
          recover: () => Effect.void,
        };
      }),
    complete: unused,
    stop: unused,
    preflight: unused,
  };
  return {
    restored,
    layer: Harnesses.layerFrom(HarnessCatalog.make({ descriptors: [claude] }), [runtime]),
  };
};

/** The harness catalog, with every Claude Code profile lacking `capabilities` for `reason`. */
const lacking = (capabilities: ReadonlyArray<Capability>, reason: string) =>
  HarnessCatalog.make({
    descriptors: catalog.descriptors.map((descriptor) =>
      descriptor.id === claude.id
        ? HarnessDescriptor.make({
            ...descriptor,
            capabilities: Arr.map(descriptor.capabilities, (profile) =>
              CapabilityProfile.make({
                ...profile,
                supported: profile.supported.filter(
                  (supported) => !capabilities.includes(supported),
                ),
                lacking: [
                  ...profile.lacking,
                  ...capabilities.map((capability) => Lacking.make({ capability, reason })),
                ],
              }),
            ),
          })
        : descriptor,
    ),
  });

/**
 * The pool that each recorded scenario's credential route bills: Claude Code and Codex ran on
 * `gateway-subscription`, Pi on `gateway`.
 */
const recordedPools = {
  claude: claudePlan.id,
  pi: apiKeys.id,
  codex: chatgptPlan.id,
} satisfies Record<SupervisorProvider, BillingPool>;

const unresumable = lacking(["resume-session"], "This test's harness reopens no saved session");
const unsteerable = lacking(["steer", "interrupt"], "This test's harness takes no interventions");

/**
 * Reports, after the first assistant message, that the request ran on usage credits after the
 * five-hour window rejected it, in the shape that Claude Code 2.1.311 emits.
 */
const onUsageCredits = (transcript: Transcript): Transcript => {
  const first = transcript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" &&
      isJsonObject(entry.payload) &&
      entry.payload.type === "assistant",
  );
  const answered = transcript.entries[first];
  assert(answered?.type === "emit_inbound", "the recorded session answers");
  const report = {
    type: "emit_inbound" as const,
    port: answered.port,
    payload: {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1_794_459_600,
        rateLimitType: "five_hour",
        utilization: 1,
        overageStatus: "allowed",
        isUsingOverage: true,
        overageInUse: true,
      },
      session_id: "$SESSION_1",
    },
  };
  return {
    ...transcript,
    entries: [
      ...transcript.entries.slice(0, first + 1),
      report,
      ...transcript.entries.slice(first + 1),
    ],
  };
};

/**
 * Rewrites the committed native Codex supervisor transcript into the container process-owner
 * framing that a live Codex supervisor recording produces.
 */
const asFramedContainer = (transcript: Transcript): Transcript => {
  const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const encodeJson = (value: Schema.Json) =>
    // @effect-diagnostics-next-line schemaSync:off
    Schema.encodeSync(Schema.fromJsonString(Schema.Json))(value);
  const turns = [
    { source: "process:1", base: 1, mode: "replace" },
    { source: "process:2", base: 4, mode: "resume" },
  ] as const;
  const entries: Array<Transcript["entries"][number]> = [];
  for (const { source, base, mode } of turns) {
    const port = `process:${base}`;
    const turnEntries = transcript.entries.filter(
      (entry) => entry.port === source || entry.port.startsWith(`${source}/`),
    );
    const launch = turnEntries.find(
      (entry) => entry.type === "expect_outbound" && entry.port === source,
    );
    assert(
      launch?.type === "expect_outbound" &&
        isJsonObject(launch.payload) &&
        Array.isArray(launch.payload.args),
    );
    // Native launch args are ["-e", "$CHILD_LIFELINE", pidFile, "", "codex", ...args, "-c", "cli_auth_credentials_store=..."].
    const codexArgs = launch.payload.args.slice(4).filter(Predicate.isString);
    const remoteArgs =
      codexArgs.at(-2) === "-c" && codexArgs.at(-1) === 'cli_auth_credentials_store="file"'
        ? codexArgs.slice(0, -2)
        : codexArgs;
    const ownerCommand = [
      "node",
      "-e",
      "$PROCESS_OWNER",
      mode,
      "$WORKTREE.child-1.pid",
      "0",
      "120000",
      ...remoteArgs,
    ]
      .map(shellQuote)
      .join(" ");
    entries.push(
      {
        type: "expect_outbound",
        port,
        payload: {
          command: "$CONTAINER_RUNTIME",
          args: ["exec", "-i", "$CONTRACT_CONTAINER", "sh", "-c", `cd '/' && exec ${ownerCommand}`],
        },
      },
      {
        type: "expect_outbound",
        port: `${port}/stdin`,
        payload: { ...transcript.environment },
      },
      {
        type: "emit_inbound",
        port: `${port}/stdout`,
        payload: { offset: 0, ready: true, sequence: 0, retained: false },
      },
    );
    let sequence = 0;
    let offset = 0;
    for (const entry of turnEntries) {
      if (entry.type === "expect_outbound" && entry.port === `${source}/stdin`) {
        sequence += 1;
        if (isJsonObject(entry.payload) && entry.payload.eof === true) {
          entries.push({
            type: "expect_outbound",
            port: `${port}/stdin`,
            payload: { sequence, eof: true },
          });
        } else {
          entries.push({
            type: "expect_outbound",
            port: `${port}/stdin`,
            payload: { sequence, data: { base64: `${encodeJson(entry.payload)}\n` } },
          });
        }
      } else if (entry.type === "emit_inbound" && entry.port === `${source}/stdout`) {
        const line = `${encodeJson(entry.payload)}\n`;
        offset += Buffer.byteLength(line);
        entries.push({
          type: "emit_inbound",
          port: `${port}/stdout`,
          payload: { offset, stdout: { base64: line } },
        });
      }
    }
    entries.push(
      {
        type: "emit_inbound",
        port: `${port}/stdout`,
        payload: { offset, exitCode: 0, stderrTail: "" },
      },
      { type: "runtime_exit", port: `${port}/stdout`, code: 0, error: null },
      { type: "runtime_exit", port: `${port}/exit`, code: 0, error: null },
    );
    for (const [step, action] of [
      [1, "stop"],
      [2, "remove"],
    ] as const) {
      const cleanup = `process:${base + step}`;
      entries.push(
        {
          type: "expect_outbound",
          port: cleanup,
          payload: {
            command: "$CONTAINER_RUNTIME",
            args: [
              "exec",
              "-i",
              "$CONTRACT_CONTAINER",
              "sh",
              "-c",
              `exec 'node' '-e' '$PROCESS_OWNER' '${action}' '$WORKTREE.child-1.pid' '0' '120000'`,
            ],
          },
        },
        { type: "expect_outbound", port: `${cleanup}/stdin`, payload: { eof: true } },
        { type: "runtime_exit", port: `${cleanup}/stdout`, code: 0, error: null },
        { type: "runtime_exit", port: `${cleanup}/exit`, code: 0, error: null },
      );
    }
  }
  return { ...transcript, entries };
};

describe("the supervisor role", () => {
  it.effect("passes the seat's frame allowance into the Codex connection", () => {
    const opened: Array<number | undefined> = [];
    const server = Layer.succeed(CodexAppServer)({
      stop: () => Effect.void,
      open: (client) =>
        Effect.gen(function* () {
          opened.push(client.protocolFrameMib);
          return yield* SessionOperationError.make({
            operation: "launch",
            sessionId: client.sessionId,
            message: "Stopped at the connection boundary",
            cause: undefined,
          });
        }),
    });
    const harnesses = Layer.unwrap(
      Effect.map(codexRuntime, (runtime) =>
        Harnesses.layerFrom(HarnessCatalog.make({ descriptors: [codex] }), [runtime]),
      ),
    ).pipe(Layer.provide(server));
    return Effect.gen(function* () {
      const failure = yield* runSupervisorTurn(
        SupervisorTurn.make({
          session: conversation,
          brain: BrainSpec.make({
            harness: codex.id,
            model: ModelId.make("gpt-5.6-terra"),
            effort: "low",
          }),
          seat,
          saved: Option.none(),
          usage: Option.none(),
          message: "Inspect the factory",
        }),
        operatorTools,
      ).pipe(Effect.flip);
      assert.include(failure.message, "Stopped at the connection boundary");
      assert.deepStrictEqual(opened, [12]);
    }).pipe(Effect.provide([harnesses, operatorToolHandlers]), Effect.provide(NodeServices.layer));
  });

  for (const provider of supervisorProviders)
    it.live(
      `${provider}: reads the source, calls one operator tool, and resumes the session`,
      () =>
        Effect.gen(function* () {
          const logs = collectLogs(["Info"]);
          const { replies, brain } = yield* runSupervisorScenario(provider, "replay").pipe(
            Effect.provide(logs.layer),
          );
          const [first, second] = replies;

          assert(Option.isSome(first.usage) && Option.isSome(second.usage));
          assert.isAtLeast(
            second.usage.value.totalTokens,
            first.usage.value.totalTokens,
            "the second turn's usage includes the first turn's",
          );
          if (provider === "claude") {
            // Claude restores the first process's 8175 tokens on resume; the session counts them once.
            assert.deepStrictEqual(
              [first.usage.value.totalTokens, second.usage.value.totalTokens],
              [8175, 12063],
            );
            assert.deepInclude(
              logs.records.map(({ message }) => message),
              [
                "Claude restored the resumed session's usage; counting it once",
                {
                  sessionId: "replay-parent:child:1",
                  resultTokens: 12063,
                  processTokens: 3888,
                  restoredTokens: 8175,
                },
              ],
            );
          }

          for (const reply of replies) {
            assert(Option.isSome(reply.usage), "each turn reports the session's usage");
            const { session, totalTokens } = reply.usage.value;
            assert(session._tag === "RoleSession");
            assert.strictEqual(session.role, supervisor.name);
            assert.strictEqual(session.id, "replay-parent:child:1");
            assert.strictEqual(
              session.agent,
              "supervisor",
              "the role runs the instance brain under the agent name supervisor",
            );
            assert.deepStrictEqual(session.brain, brain, "the session records the brain that ran");
            assert.deepStrictEqual(
              session.pool,
              Option.some(recordedPools[provider]),
              "the seat's credential route sets the pool that pays",
            );
            assert.isAbove(totalTokens, 0);
            for (const event of reply.events) {
              assert(event.session._tag === "RoleSession", `${event._tag} keeps the role session`);
              assert.strictEqual(
                event.session.agent,
                "supervisor",
                `${event._tag} carries the agent name supervisor`,
              );
            }
            assertProvenCapabilities(Harness.make(provider), "supervisor", reply.events);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("20 seconds")),
      30_000,
    );

  it.live(
    "codex: replays framed container traffic and decodes offered tools",
    () =>
      Effect.gen(function* () {
        const { replies } = yield* runSupervisorScenario("codex", "replay", {
          transform: asFramedContainer,
        });
        for (const reply of replies)
          assertProvenCapabilities(Harness.make("codex"), "supervisor", reply.events);
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("20 seconds")),
    30_000,
  );

  it.live(
    "codex: normalizes container runtime, container name, and process owner at their argument positions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "codex-container-" });
          const runtime = `${directory}/runtime`;
          yield* fs.writeFileString(
            runtime,
            '#!/bin/sh\n[ "$1" = exec ] && [ "$2" = -i ] && [ "$3" = codex ] || exit 125\nexit 0\n',
          );
          yield* fs.chmod(runtime, 0o700);
          const recordTape = new Tape("record");
          const recordedHost = yield* replayContainerHost("codex", recordTape, {
            runtime,
            name: "codex",
          });
          const invocation = {
            cwd: "/",
            command: "node",
            args: [
              "-e",
              PROCESS_OWNER,
              "replace",
              "/tmp/worktree.child-1.pid",
              "0",
              "120000",
              "codex",
              "app-server",
              "--stdio",
            ],
            environment: {},
          };
          const recordedProcess = yield* recordedHost.transport.run(
            remoteCommandLine(recordedHost, invocation),
            Stream.empty,
          );
          const recordedExit = yield* recordedProcess.exitCode;
          assert.strictEqual(recordedExit, 0);
          yield* Stream.runDrain(recordedProcess.stdout);

          const launch = recordTape.entries[0];
          assert(launch?.type === "expect_outbound" && isJsonObject(launch.payload));
          assert.strictEqual(launch.payload.command, "$CONTAINER_RUNTIME");
          assert(Array.isArray(launch.payload.args));
          assert.deepStrictEqual(launch.payload.args.slice(0, 5), [
            "exec",
            "-i",
            "$CONTRACT_CONTAINER",
            "sh",
            "-c",
          ]);
          const inner = launch.payload.args[5];
          assert.isString(inner);
          assert.include(inner, "'$PROCESS_OWNER'");
          assert.include(inner, "'codex' 'app-server'");
          assert.notInclude(inner, "$CONTRACT_CONTAINER");
          assert.isBelow(inner.length, 500);

          const replayTape = new Tape({
            protocol: "codex-app-server",
            harnessVersion: "0.172.0",
            model: "gpt-6.2-astra",
            scenario: "supervisor",
            environment: {},
            entries: recordTape.entries,
          });
          const replayedHost = yield* replayContainerHost("codex", replayTape);
          const replayedProcess = yield* replayedHost.transport.run(
            remoteCommandLine(replayedHost, invocation),
            Stream.empty,
          );
          const replayedExit = yield* replayedProcess.exitCode;
          assert.strictEqual(replayedExit, 0);
          yield* Stream.runDrain(replayedProcess.stdout);
          replayTape.assertComplete();
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("15 seconds")),
    20_000,
  );

  it.live(
    "claude: keeps answering after a request on usage credits",
    () =>
      Effect.gen(function* () {
        const logs = collectLogs(["Info", "Warn"]);
        const { replies } = yield* runSupervisorScenario("claude", "replay", {
          transform: onUsageCredits,
        }).pipe(Effect.provide(logs.layer));
        const [first, second] = replies;
        assert.include(first.message, WAITING_RUN);
        assert.include(second.message, RESUMED);
        assert.deepStrictEqual(
          logs.records.flatMap(({ level, message }) =>
            Array.isArray(message) && String(message[0]).includes("usage credits")
              ? [[level, message[0]]]
              : [],
          ),
          [["Info", "Claude child runs on usage credits, which its spec allows"]],
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("20 seconds")),
    30_000,
  );

  it("admits every harness that serves usine tools, and says which keep all their own tools", () => {
    const closedTools = codex.capabilities
      .flatMap(({ lacking }) => lacking)
      .find(({ capability }) => capability === "closed-tools");
    assert(closedTools !== undefined);
    const kept = supervisorProviders.map((provider) => {
      const admitted = admitSupervisor(
        catalog,
        BrainSpec.make({
          harness: Harness.make(provider),
          model: ModelId.make("probe"),
          effort: "low",
        }),
        "gateway",
      );
      assert(Result.isSuccess(admitted), provider);
      return [provider, admitted.success.ownToolsKept] as const;
    });
    assert.deepStrictEqual(kept, [
      ["claude", Option.none()],
      ["pi", Option.none()],
      ["codex", Option.some(closedTools.reason)],
    ]);
  });

  it.effect("refuses own-tool admission on an actual host without a container", () =>
    Effect.gen(function* () {
      const brain = BrainSpec.make({ ...claudeBrain, harness: Harness.make("codex") });
      const admitted = admitSupervisor(catalog, brain, "gateway-subscription");
      assert(Result.isSuccess(admitted));
      for (const host of [
        LocalProcess.make({}),
        ExecShell.make({
          destination: "host",
          transport: { run: () => Effect.die("refused hosts never run commands") },
        }),
      ]) {
        const spec = SessionSpec.make({
          session: RoleSession.make({
            id: conversation,
            role: supervisor.name,
            agent: supervisorAgent,
            brain,
          }),
          admitted: admitted.success,
          host,
          worker: seat.worker,
          machine: Option.none(),
          cwd: seat.cwd,
          environment: {},
        });
        const error = yield* admitSession(
          catalog,
          spec,
          StartPrompt.make({ text: "read" }),
          true,
        ).pipe(Effect.flip);
        assert.include(error.message, "requires a container");
      }
    }),
  );

  it("refuses a harness that can't reopen the saved session", () => {
    assert(Result.isSuccess(admitSupervisor(catalog, claudeBrain, "gateway")));
    const refused = admitSupervisor(unresumable, claudeBrain, "gateway");
    assert(Result.isFailure(refused));
    assert.deepStrictEqual(
      refused.failure.missing.map(({ capability }) => capability),
      ["resume-session"],
    );
    assert.include(
      refused.failure.message,
      "lacks resume-session (This test's harness reopens no saved session)",
    );
  });

  it("runs only on the gateway credential routes", () => {
    for (const credential of ["gateway", "gateway-subscription", "gateway-api-key"] as const)
      assert(Result.isSuccess(admitSupervisor(catalog, claudeBrain, credential)), credential);
    for (const credential of ["host-login", "api-key"] as const) {
      const refused = admitSupervisor(catalog, claudeBrain, credential);
      assert(Result.isFailure(refused), credential);
      assert.deepInclude(
        refused.failure.missing,
        Lacking.make({
          capability: "credential-route",
          reason: "The supervisor uses the gateway credential that the instance already has",
        }),
        credential,
      );
    }
  });

  it.effect("refuses a turn on a seat outside the gateway credential routes before it opens", () =>
    Effect.gen(function* () {
      const opened: Array<CredentialRoute> = [];
      const unused = () => assert.fail("the supervisor turn calls only open");
      const harnesses = Harnesses.layerFrom(HarnessCatalog.make({ descriptors: [claude] }), [
        {
          id: claudeBrain.harness,
          open: (spec) => {
            opened.push(spec.admitted.context.credential);
            return Effect.die("a refused supervisor turn opens no session");
          },
          complete: unused,
          stop: unused,
          preflight: unused,
        },
      ]);
      for (const credential of ["host-login", "api-key"] as const) {
        const failure = yield* runSupervisorTurn(
          SupervisorTurn.make({
            session: conversation,
            brain: claudeBrain,
            seat: SupervisorSeat.make({ ...seat, credential }),
            saved: Option.none(),
            usage: Option.none(),
            message: supervisorMessages[0],
          }),
          operatorTools,
        ).pipe(Effect.flip, Effect.provide(Layer.merge(operatorToolHandlers, harnesses)));
        assert(failure._tag === "SupervisorTurnError", credential);
        assert.strictEqual(failure.reason._tag, "AgentResultError", credential);
        assert.include(
          failure.message,
          "lacks credential-route (The supervisor uses the gateway credential that the instance already has)",
          credential,
        );
        assert.deepStrictEqual(failure.usage, Option.none(), credential);
      }
      assert.deepStrictEqual(opened, [], "no refused turn opens a session");
    }),
  );

  it("runs only at the orchestrator placement", () => {
    const elsewhere = Placement.literals.filter((placement) => placement !== "orchestrator");
    for (const placement of elsewhere) {
      const refused = admitBrain(
        catalog,
        supervisor,
        claudeBrain,
        AdmissionContext.make({ placement, credential: "gateway" }),
        { reopens: true },
      );
      assert(Result.isFailure(refused), placement);
      assert.deepInclude(
        refused.failure.missing,
        Lacking.make({
          capability: "orchestrator",
          reason: "The supervisor runs on the orchestrator host",
        }),
        placement,
      );
    }
  });

  it("refuses a harness that takes no steering or interrupts", () => {
    const refused = admitSupervisor(unsteerable, claudeBrain, "gateway");
    assert(Result.isFailure(refused));
    assert.deepStrictEqual(
      refused.failure.missing.map(({ capability }) => capability),
      ["steer", "interrupt"],
    );
    assert.include(
      refused.failure.message,
      "lacks steer (This test's harness takes no interventions)",
    );
  });

  it.effect("keeps the previous turn's usage when a turn reports none", () =>
    Effect.gen(function* () {
      const saved = HarnessSession.make({ id: HarnessSessionId.make("claude-saved"), cwd: "/tmp" });
      const scripted = scriptedClaude({
        events: Stream.make(
          SessionStarted.make({ session: spent(0).session, harnessSession: Option.some(saved) }),
        ),
        result: Effect.succeed(SessionResult.make({ message: WAITING_RUN })),
        active: false,
      });
      const reply = yield* runSupervisorTurn(
        SupervisorTurn.make({
          session: conversation,
          brain: claudeBrain,
          seat,
          saved: Option.some(saved),
          usage: Option.some(spent(1000)),
          message: supervisorMessages[1],
        }),
        operatorTools,
      ).pipe(Effect.provide(Layer.merge(operatorToolHandlers, scripted.layer)));
      assert.strictEqual(reply.message, WAITING_RUN);
      assert.deepStrictEqual(
        Option.map(reply.usage, ({ totalTokens }) => totalTokens),
        Option.some(TokenCount.make(1000)),
      );
    }),
  );

  it.effect("continues the previous turn's usage when it reopens the saved session", () =>
    Effect.gen(function* () {
      const scripted = scriptedClaude({
        events: Stream.make(spent(1300)),
        result: Effect.succeed(SessionResult.make({ message: WAITING_RUN })),
        active: false,
      });
      const saved = HarnessSession.make({ id: HarnessSessionId.make("claude-saved"), cwd: "/tmp" });
      const reply = yield* runSupervisorTurn(
        SupervisorTurn.make({
          session: conversation,
          brain: claudeBrain,
          seat,
          saved: Option.some(saved),
          usage: Option.some(spent(1000)),
          message: supervisorMessages[1],
        }),
        operatorTools,
      ).pipe(Effect.flip, Effect.provide(Layer.merge(operatorToolHandlers, scripted.layer)));
      // The scripted session reports no saved conversation, so the turn fails after it answers.
      assert(reply._tag === "SupervisorTurnError");
      assert.deepStrictEqual(
        scripted.restored.map(({ usage }) => Option.map(usage, ({ totalTokens }) => totalTokens)),
        [Option.some(TokenCount.make(1000))],
        "the reopened session counts on from the previous turn's usage",
      );
      assert.deepStrictEqual(
        Option.map(reply.usage, ({ totalTokens }) => totalTokens),
        Option.some(TokenCount.make(1300)),
      );
    }),
  );

  it.effect("keeps the usage that a failed turn spent", () =>
    Effect.gen(function* () {
      const capacity = AgentCapacityError.make({
        sessionId: Option.some(conversation),
        message: "The selected model is at capacity",
      });
      const scripted = scriptedClaude({
        events: Stream.concat(Stream.make(spent(4321)), Stream.fail(capacity)),
        result: Effect.fail(capacity),
        active: false,
      });
      const failure = yield* runSupervisorTurn(
        SupervisorTurn.make({
          session: conversation,
          brain: claudeBrain,
          seat,
          saved: Option.none(),
          usage: Option.none(),
          message: supervisorMessages[0],
        }),
        operatorTools,
      ).pipe(Effect.flip, Effect.provide(Layer.merge(operatorToolHandlers, scripted.layer)));
      assert(failure._tag === "SupervisorTurnError");
      assert.strictEqual(failure.reason, capacity);
      assert.deepStrictEqual(
        Option.map(failure.usage, ({ totalTokens }) => totalTokens),
        Option.some(TokenCount.make(4321)),
      );
    }),
  );

  it.effect("refuses and logs a turn whose saved session is still running", () =>
    Effect.gen(function* () {
      const logs = collectLogs(["Warn"]);
      const scripted = scriptedClaude({
        events: Stream.never,
        result: Effect.never,
        active: true,
      });
      const saved = HarnessSession.make({ id: HarnessSessionId.make("claude-busy"), cwd: "/tmp" });
      const failure = yield* runSupervisorTurn(
        SupervisorTurn.make({
          session: conversation,
          brain: claudeBrain,
          seat,
          saved: Option.some(saved),
          usage: Option.some(spent(1000)),
          message: supervisorMessages[1],
        }),
        operatorTools,
      ).pipe(Effect.flip, Effect.provide([operatorToolHandlers, scripted.layer, logs.layer]));
      assert(failure._tag === "SupervisorTurnError");
      assert.strictEqual(failure.reason._tag, "AgentResultError");
      assert.strictEqual(failure.message, "The supervisor's saved session is still running a turn");
      assert.deepStrictEqual(
        Option.map(failure.usage, ({ totalTokens }) => totalTokens),
        Option.some(TokenCount.make(1000)),
        "the refused turn reports the usage that the session had",
      );
      assert.deepStrictEqual(
        logs.records.map(({ message }) => message),
        [
          [
            "Supervisor turn refused: the saved session is still running",
            { sessionId: conversation, harnessSessionId: "claude-busy" },
          ],
        ],
      );
    }),
  );
});

it("refuses supervisor seats without a container", () => {
  for (const host of [
    LocalProcess.make(),
    ExecShell.make({
      destination: "host",
      transport: { run: () => Effect.die("must not execute") },
    }),
  ]) {
    const decoded = Schema.decodeUnknownResult(SupervisorSeat)({ ...seat, host });
    assert.isTrue(Result.isFailure(decoded));
  }
});

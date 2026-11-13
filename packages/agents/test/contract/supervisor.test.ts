import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  type AgentSessionEvent,
  type BillingPool,
  HarnessSession,
  HarnessSessionId,
  RoleSession,
  SessionStarted,
  SessionTokensUpdated,
  TokenCount,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { WorkerName } from "@usine/core/worker";
import { Array as Arr, Effect, Layer, Option, Result, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
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
import type { NativeSession } from "../../src/harness/contract.ts";
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
  type AgentSessionError,
  RestartState,
  SessionResult,
  WorkingDirectory,
} from "../../src/runtime.ts";
import { collectLogs } from "../logs.ts";
import { assertProvenCapabilities } from "./capabilities.ts";
import { listedTools } from "./host-tools.ts";
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

/** The names under which `provider` lists the toolkit's tools, sorted. */
const operatorNames = (provider: SupervisorProvider) =>
  Object.keys(operatorTools.tools)
    .map((name) => (provider === "claude" ? `mcp__usine__${name}` : name))
    .sort();

const seat = SupervisorSeat.make({
  host: LocalProcess.make(),
  worker: WorkerName.make("orchestrator"),
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
 * The pool that each recorded scenario's credential route bills: Claude Code ran on
 * `gateway-subscription`, Pi on `gateway`.
 */
const recordedPools = {
  claude: "claudePlan",
  pi: "apiKeys",
} satisfies Record<SupervisorProvider, BillingPool>;

const unresumable = lacking(["resume-session"], "This test's harness reopens no saved session");
const unsteerable = lacking(["steer", "interrupt"], "This test's harness takes no interventions");

const started = (events: ReadonlyArray<AgentSessionEvent>) =>
  events.flatMap((event) => (event._tag === "ToolStarted" ? [event.tool] : []));
const finished = (events: ReadonlyArray<AgentSessionEvent>) =>
  events.flatMap((event) =>
    event._tag === "ToolFinished" ? [{ tool: event.tool, isError: event.isError }] : [],
  );

describe("the supervisor role", () => {
  for (const provider of supervisorProviders)
    it.live(
      `${provider}: lists only the operator tools, calls one, and resumes the session`,
      () =>
        Effect.gen(function* () {
          const logs = collectLogs(["Info"]);
          const { replies, entries, brain } = yield* runSupervisorScenario(provider, "replay").pipe(
            Effect.provide(logs.layer),
          );
          const [first, second] = replies;
          assert.include(first.message, WAITING_RUN);
          assert.deepStrictEqual(started(first.events), ["overview"]);
          assert.deepStrictEqual(finished(first.events), [{ tool: "overview", isError: false }]);
          assert.strictEqual(first.events.at(-1)?._tag, "SessionFinished");

          const listed = listedTools(provider, entries);
          assert.isNotEmpty(listed, "the recorded traffic shows the session's tool list");
          for (const offered of listed)
            assert.deepStrictEqual(
              [...offered].sort(),
              operatorNames(provider),
              "the session lists the operator tools and no harness tool",
            );

          assert.include(second.message, WAITING_RUN, "the second turn recalls the first");
          assert.include(second.message, RESUMED);
          assert.deepStrictEqual(started(second.events), []);
          assert.strictEqual(
            second.saved.id,
            first.saved.id,
            "the second turn reopens the session",
          );
          const reopened = second.events.find((event) => event._tag === "SessionStarted");
          assert(reopened?._tag === "SessionStarted");
          assert.deepStrictEqual(
            Option.map(reopened.harnessSession, ({ id }) => id),
            Option.some(first.saved.id),
          );

          assert(Option.isSome(first.usage) && Option.isSome(second.usage));
          assert.isAtLeast(
            second.usage.value.totalTokens,
            first.usage.value.totalTokens,
            "the second turn's usage includes the first turn's",
          );
          if (provider === "claude") {
            // Claude restores the first process's 3591 tokens on resume; the session counts them once.
            assert.deepStrictEqual(
              [first.usage.value.totalTokens, second.usage.value.totalTokens],
              [3591, 5133],
            );
            assert.deepInclude(
              logs.records.map(({ message }) => message),
              [
                "Claude restored the resumed session's usage; counting it once",
                {
                  sessionId: "replay-parent:child:1",
                  resultTokens: 5133,
                  processTokens: 1542,
                  restoredTokens: 3591,
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
            assert.deepStrictEqual(session.brain, brain, "the session records the brain that ran");
            assert.deepStrictEqual(
              session.pool,
              Option.some(recordedPools[provider]),
              "the seat's credential route sets the pool that pays",
            );
            assert.isAbove(totalTokens, 0);
            for (const event of reply.events)
              assert(event.session._tag === "RoleSession", `${event._tag} keeps the role session`);
            assertProvenCapabilities(Harness.make(provider), "supervisor", reply.events);
          }
        }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("20 seconds")),
      30_000,
    );

  it.effect("codex: the descriptor refuses the role because Codex lists its own tools", () =>
    Effect.gen(function* () {
      const brain = BrainSpec.make({
        harness: Harness.make("codex"),
        model: ModelId.make("gpt-5.6-terra"),
        effort: "low",
      });
      const refused = admitSupervisor(catalog, brain, "gateway");
      assert(Result.isFailure(refused));
      const closedTools = codex.capabilities
        .flatMap(({ lacking }) => lacking)
        .find(({ capability }) => capability === "closed-tools");
      assert(closedTools !== undefined);
      assert.deepStrictEqual(
        refused.failure.missing.map(({ capability }) => capability),
        ["closed-tools"],
      );
      assert.include(refused.failure.message, `lacks closed-tools (${closedTools.reason})`);

      // The same toolkit and turn as on the other harnesses: admission refuses it before any
      // session opens.
      const unreachable = () => assert.fail("a refused supervisor turn opens no session");
      const harnesses = Harnesses.layerFrom(HarnessCatalog.make({ descriptors: [codex] }), [
        {
          id: brain.harness,
          open: unreachable,
          complete: unreachable,
          stop: unreachable,
          preflight: unreachable,
        },
      ]);
      const failure = yield* runSupervisorTurn(
        SupervisorTurn.make({
          session: AgentSessionId.make("supervisor:codex"),
          brain,
          seat: SupervisorSeat.make({
            host: LocalProcess.make(),
            worker: WorkerName.make("orchestrator"),
            cwd: WorkingDirectory.make("/tmp"),
            environment: {},
            credential: "gateway",
          }),
          saved: Option.none(),
          usage: Option.none(),
          message: supervisorMessages[0],
        }),
        operatorTools,
      ).pipe(Effect.flip, Effect.provide(Layer.merge(operatorToolHandlers, harnesses)));
      assert(failure._tag === "SupervisorTurnError");
      assert.strictEqual(failure.reason._tag, "AgentResultError");
      assert.strictEqual(failure.message, refused.failure.message);
      assert.deepStrictEqual(failure.usage, Option.none());
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

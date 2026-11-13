import { assert, describe, it } from "@effect/vitest";
import {
  CapabilityProfile,
  catalog,
  HarnessCatalog,
  HarnessDescriptor,
  Lacking,
} from "@usine/agents/harness";
import {
  type Completion,
  CompletionError,
  type CompletionFailure,
  CompletionInvalid,
  CompletionRefused,
  type SessionSpec,
} from "@usine/agents/harness/contract";
import type { HarnessRuntime } from "@usine/agents/harness/node";
import { Harnesses } from "@usine/agents/harness/registry";
import { AgentCapacityError, SessionOperationError } from "@usine/agents/runtime";
import { Agent, DecisionBrain } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  type BillingPool,
  ChildSessionCount,
  RoleSession,
  SessionTokensUpdated,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import type { GatewayCredentialKind } from "@usine/core/worker";
import {
  Array as Arr,
  DateTime,
  Effect,
  Fiber,
  Formatter,
  Layer,
  Logger,
  Option,
  Schema,
} from "effect";

import { AttemptRequest } from "../src/attempt-runtime.ts";
import {
  AtCapacity,
  AttemptContext,
  AttemptStarted,
  Blocked,
  BudgetExceeded,
  ChildAtCapacity,
  ChildFailed,
  ChildInterrupted,
  ChildReported,
  Complete,
  type CoordinatorEvent,
  Failed,
  InfraFailed,
  type ModelDecision,
  Question,
  ReservedReport,
  RetryChild,
} from "../src/attempt/coordinator/rules.ts";
import { childSessionId } from "../src/attempt/sessions.ts";
import { CompletionAnswer, completionWakeUp } from "../src/coordinator/completion.ts";
import { EventSequence } from "../src/coordinator/journal.ts";
import {
  HandlerSession,
  HandlerUsage,
  RecordedDecision,
  WakeUp,
} from "../src/coordinator/wake-up.ts";
import { coordinated, coordinatorWith, orchestrator, stored } from "./coordinator-support.ts";
import { recordingSink, temporaryDatabase, sqliteJournal } from "./support.ts";

const DECISION_MODEL = ModelId.make("claude-haiku-4-5");

/** The worker's credential for a request: the gateway's kind and the harness environment. */
interface WorkerCredential {
  readonly gateway?: GatewayCredentialKind;
  readonly environment?: Readonly<Record<string, string>>;
}

/** A request whose agent decides with `DECISION_MODEL`, or without a decision brain. */
const requestFor = (
  attemptId: string,
  decision = true,
  maxChildren = 3,
  credential: WorkerCredential = {},
) => {
  const request = coordinated(attemptId, maxChildren);
  return AttemptRequest.make({
    ...request,
    environment: { ...request.environment, ...credential.environment },
    gatewayCredential: Effect.succeed(Option.fromNullishOr(credential.gateway)),
    spec: AttemptChannel.RunSpec.make({
      ...request.spec,
      agent: Agent.make({
        ...request.spec.agent,
        decision: decision
          ? Option.some(DecisionBrain.make({ model: DECISION_MODEL, effort: "low" }))
          : Option.none(),
      }),
    }),
  });
};

const reported = (report: string, reserved = Option.none<ReservedReport>()) =>
  ChildReported.make({
    child: ChildSessionCount.make(1),
    report,
    answeredOperator: false,
    reserved,
  });

const contextFor = (request: AttemptRequest, event: CoordinatorEvent) =>
  AttemptContext.make({
    event,
    maxChildren: request.spec.maxChildren,
    repository: request.spec.repository,
    agent: request.spec.agent.name,
    task: request.spec.task,
    outcomeLabels: request.spec.outcomeLabels,
    requiresCi: request.spec.requiresCi,
    delegations: [],
    output: "",
  });

/** The usage that a scripted completion reports for `spec`, with the pool that admission set. */
const usageOf = (spec: SessionSpec) =>
  SessionTokensUpdated.make({
    session:
      spec.session._tag === "RoleSession" && Option.isSome(spec.admitted.pool)
        ? RoleSession.make({ ...spec.session, pool: spec.admitted.pool })
        : spec.session,
    totalTokens: TokenCount.make(800),
    costUsd: Option.some(UsdAmount.make(0.002)),
  });

type Script = (spec: SessionSpec) => Effect.Effect<Schema.Json, CompletionError>;

/** Answers the completion with `answer`, which the output schema decodes like a harness reply. */
const answering =
  (answer: Schema.Json): Script =>
  () =>
    Effect.succeed(answer);

/** Fails the completion with `reason`, with the usage spent before it or none. */
const failing =
  (reason: (sessionId: AgentSessionId) => CompletionFailure, spent: boolean): Script =>
  (spec) =>
    Effect.fail(
      CompletionError.make({
        sessionId: spec.session.id,
        reason: reason(spec.session.id),
        usage: spent ? Option.some(usageOf(spec)) : Option.none(),
        message: reason(spec.session.id).message,
      }),
    );

/**
 * Harness runtimes from `harnesses` whose completions follow `script`, recording each call's spec
 * and prompt.
 */
const harnessesWith = (script: Script, harnesses: HarnessCatalog = catalog) => {
  const calls: Array<{ readonly spec: SessionSpec; readonly prompt: string }> = [];
  const runtimes = harnesses.ids.map((id): HarnessRuntime => ({
    id,
    open: () => Effect.die(new Error("A completion opens no session")),
    stop: () => Effect.void,
    preflight: () => Effect.die(new Error("A completion runs no preflight")),
    complete: <A>(
      spec: SessionSpec,
      prompt: string,
      output: Schema.Codec<A, unknown, never, unknown>,
    ): Effect.Effect<Completion<A>, CompletionError> =>
      Effect.sync(() => calls.push({ spec, prompt })).pipe(
        Effect.andThen(script(spec)),
        Effect.flatMap((answer) =>
          Schema.decodeEffect(Schema.toCodecJson(output))(answer).pipe(Effect.orDie),
        ),
        Effect.map((value) => ({ value, usage: usageOf(spec) })),
      ),
  }));
  return {
    calls,
    layer: completionWakeUp.pipe(
      Layer.provide(Harnesses.layerFrom(harnesses, runtimes).pipe(Layer.orDie)),
    ),
  };
};

/**
 * Wakes the completion handler for `event` and returns its answer, the usage it recorded, and its
 * logs.
 */
const wake = (
  script: Script,
  request: AttemptRequest,
  event: CoordinatorEvent,
  harnessCatalog: HarnessCatalog = catalog,
) =>
  Effect.gen(function* () {
    const harnesses = harnessesWith(script, harnessCatalog);
    const recorded: Array<SessionTokensUpdated> = [];
    const logged: Array<{ readonly level: string; readonly entry: string }> = [];
    const logger = Logger.layer([
      Logger.make(({ logLevel, message }) =>
        logged.push({ level: logLevel, entry: Formatter.format(message) }),
      ),
    ]);
    const decision = yield* Effect.flatMap(Effect.service(WakeUp), (wakeUp) =>
      wakeUp.handle(event, contextFor(request, event), {
        attemptId: request.spec.attemptId,
        sequence: EventSequence.make(2),
        spec: request.spec,
        request: Effect.succeed(request),
        recordUsage: (usage) => Effect.sync(() => recorded.push(usage)),
      }),
    ).pipe(Effect.provide(Layer.merge(harnesses.layer, logger)));
    /** Whether the handler logged at Warning that the rule applies because of `reason`. */
    const fellBack = (reason: string) =>
      logged.some(
        ({ level, entry }) =>
          level === "Warn" && entry.includes("its rule applies") && entry.includes(reason),
      );
    return { decision, recorded, calls: harnesses.calls, logged, fellBack };
  });

const retry = {
  decision: { _tag: "RetryChild", assignment: "Push the branch you committed." },
  reason: "The report says the branch isn't pushed.",
};

describe("structured completion wake-up", () => {
  it.effect("records a valid decision with the completion's brain, route, pool, and usage", () =>
    Effect.gen(function* () {
      const request = requestFor("completion/valid");
      const { decision, recorded, calls, logged } = yield* wake(
        answering(retry),
        request,
        reported("Committed the fix, but the push failed."),
      );

      const brain = BrainSpec.make({
        harness: Harness.make("claude"),
        model: DECISION_MODEL,
        effort: "low",
      });
      assert.deepStrictEqual(
        decision,
        Option.some(
          RecordedDecision.make({
            decision: RetryChild.make({ assignment: "Push the branch you committed." }),
            handler: "completion",
            session: Option.some(
              HandlerSession.make({
                brain,
                route: "host-login",
                pool: "claudePlan",
                usage: HandlerUsage.make({
                  totalTokens: TokenCount.make(800),
                  costUsd: Option.some(UsdAmount.make(0.002)),
                }),
              }),
            ),
          }),
        ),
      );
      assert.strictEqual(calls.length, 1);
      const [call] = calls;
      if (call === undefined) return assert.fail("The handler called no completion");
      const { spec, prompt } = call;
      assert.deepStrictEqual(
        {
          id: spec.session.id,
          session: spec.session._tag,
          parentId: spec.session._tag === "RoleSession" ? spec.session.parentId : Option.none(),
          role: spec.admitted.role.name,
          brain: spec.session.brain,
          placement: spec.admitted.context.placement,
          credential: spec.admitted.context.credential,
          worker: spec.worker,
          cwd: spec.cwd,
          environment: spec.environment,
        },
        {
          id: AgentSessionId.make("parent:completion/valid:decision:2"),
          session: "RoleSession",
          parentId: Option.some(childSessionId(request.spec.attemptId, ChildSessionCount.make(1))),
          role: "decision-completion",
          brain,
          placement: "local",
          credential: "host-login",
          worker: request.worker,
          cwd: request.cwd,
          environment: request.environment,
        },
      );
      assert.include(prompt, "Committed the fix, but the push failed.");
      assert.deepStrictEqual(
        recorded.map(({ session, totalTokens }) => [session.id, totalTokens]),
        [[spec.session.id, 800]],
      );
      assert.isTrue(
        logged.some(
          ({ level, entry }) =>
            level === "Info" &&
            entry.includes("The structured completion decided the event") &&
            entry.includes(retry.reason),
        ),
      );
    }),
  );

  const branches: ReadonlyArray<readonly [string, Schema.Json, ModelDecision]> = [
    [
      "Complete with a message",
      { _tag: "Complete", message: "Opened #12." },
      Complete.make({ message: "Opened #12." }),
    ],
    [
      "RetryChild without an assignment",
      { _tag: "RetryChild", assignment: null },
      RetryChild.make({}),
    ],
    ["Blocked without a message", { _tag: "Blocked", message: null }, Blocked.make({})],
    [
      "Blocked with a message",
      { _tag: "Blocked", message: "No access." },
      Blocked.make({ message: "No access." }),
    ],
    [
      "Question",
      { _tag: "Question", question: "Which branch?" },
      Question.make({ question: "Which branch?" }),
    ],
    [
      "Failed",
      { _tag: "Failed", message: "The tests fail." },
      Failed.make({ message: "The tests fail." }),
    ],
    [
      "InfraFailed",
      { _tag: "InfraFailed", message: "The checkout is gone." },
      InfraFailed.make({ message: "The checkout is gone." }),
    ],
    [
      "AtCapacity without a reset time",
      { _tag: "AtCapacity", message: "Usage limit.", resetsAt: null },
      AtCapacity.make({ message: "Usage limit." }),
    ],
    [
      "AtCapacity with a reset time",
      { _tag: "AtCapacity", message: "Usage limit.", resetsAt: "2026-11-13T15:00:00.000Z" },
      AtCapacity.make({
        message: "Usage limit.",
        resetsAt: DateTime.makeUnsafe("2026-11-13T15:00:00Z"),
      }),
    ],
  ];

  for (const [name, answer, expected] of branches) {
    it.effect(`decides ${name} as the answer states`, () =>
      Effect.gen(function* () {
        const { decision } = yield* wake(
          answering({ decision: answer, reason: "The report says so." }),
          requestFor(`completion/branch-${expected._tag}`),
          reported("Stopped before the push."),
        );

        assert.deepStrictEqual(
          Option.map(decision, ({ decision }) => decision),
          Option.some(expected),
        );
      }),
    );
  }

  const routes: ReadonlyArray<readonly [WorkerCredential, string, Option.Option<BillingPool>]> = [
    [{ gateway: "api-key" }, "gateway-api-key", Option.some("apiKeys")],
    [{ gateway: "subscription" }, "gateway-subscription", Option.some("claudePlan")],
    [{ environment: { ANTHROPIC_API_KEY: "sk-test" } }, "api-key", Option.none()],
    [{}, "host-login", Option.none()],
  ];

  for (const [credential, route, pool] of routes) {
    it.effect(`admits and records the child's ${route} credential route`, () =>
      Effect.gen(function* () {
        const { decision, calls } = yield* wake(
          answering(retry),
          requestFor(`completion/route-${route}`, true, 3, credential),
          reported("Committed the fix, but the push failed."),
        );

        const [call] = calls;
        if (call === undefined) return assert.fail("The handler called no completion");
        assert.deepStrictEqual(
          {
            admitted: call.spec.admitted.context.credential,
            pool: call.spec.admitted.pool,
            recorded: Option.map(
              Option.flatMap(decision, ({ session }) => session),
              (session) => session.route,
            ),
          },
          { admitted: route, pool, recorded: Option.some(route) },
        );
        if (Option.isSome(pool))
          assert.deepStrictEqual(
            Option.map(
              Option.flatMap(decision, ({ session }) => session),
              (session) => session.pool,
            ),
            pool,
          );
      }),
    );
  }

  it.effect("leaves every event other than a report to the rule without a model call", () =>
    Effect.gen(function* () {
      const child = ChildSessionCount.make(1);
      const events: ReadonlyArray<CoordinatorEvent> = [
        AttemptStarted.make({}),
        ChildFailed.make({ child, message: "The worker lost its transport." }),
        ChildInterrupted.make({ child, reason: "The checkout is gone." }),
        ChildAtCapacity.make({ child, message: "Usage limit.", resetsAt: Option.none() }),
        BudgetExceeded.make({ child, attempted: ChildSessionCount.make(4) }),
      ];

      for (const event of events) {
        const { decision, calls, recorded } = yield* wake(
          answering({ decision: { _tag: "Complete", message: "Done." }, reason: "Done." }),
          requestFor(`completion/event-${event._tag}`),
          event,
        );

        assert.isTrue(Option.isNone(decision), event._tag);
        assert.strictEqual(calls.length, 0, event._tag);
        assert.strictEqual(recorded.length, 0, event._tag);
      }
    }),
  );

  it.effect("falls back to the rule when admission refuses the decision brain", () =>
    Effect.gen(function* () {
      const harness = Harness.make("claude");
      const claude = Option.getOrThrow(catalog.get(harness));
      const withoutStructuredOutput = HarnessDescriptor.make({
        ...claude,
        capabilities: Arr.map(claude.capabilities, (profile) =>
          CapabilityProfile.make({
            ...profile,
            supported: profile.supported.filter((capability) => capability !== "structured-output"),
            lacking: [
              ...profile.lacking,
              Lacking.make({
                capability: "structured-output",
                reason: "The test harness returns no structured value",
              }),
            ],
          }),
        ),
      });
      const refusing = HarnessCatalog.make({
        descriptors: catalog.descriptors.map((descriptor) =>
          descriptor.id === harness ? withoutStructuredOutput : descriptor,
        ),
      });

      const { decision, calls, recorded, fellBack } = yield* wake(
        answering(retry),
        requestFor("completion/refused-admission"),
        reported("Committed the fix, but the push failed."),
        refusing,
      );

      assert.isTrue(Option.isNone(decision));
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(recorded.length, 0);
      assert.isTrue(fellBack("claude cannot run as decision-completion at local"));
      assert.isTrue(fellBack("The test harness returns no structured value"));
    }),
  );

  it.effect("completes with the child's report when the answer leaves the message null", () =>
    Effect.gen(function* () {
      const { decision } = yield* wake(
        answering({ decision: { _tag: "Complete", message: null }, reason: "Done." }),
        requestFor("completion/default-message"),
        reported("Opened #12."),
      );

      assert.deepStrictEqual(
        Option.map(decision, ({ decision }) => decision),
        Option.some(Complete.make({})),
      );
    }),
  );

  it.effect("falls back to the rule on an invalid value and records its usage", () =>
    Effect.gen(function* () {
      const { decision, recorded, fellBack } = yield* wake(
        failing(
          (sessionId) =>
            CompletionInvalid.make({
              sessionId,
              message: "The completion doesn't match its output schema",
            }),
          true,
        ),
        requestFor("completion/invalid"),
        reported("Opened #12."),
      );

      assert.isTrue(Option.isNone(decision));
      assert.isTrue(fellBack("CompletionInvalid: The completion doesn't match its output schema"));
      assert.deepStrictEqual(
        recorded.map(({ totalTokens }) => totalTokens),
        [800],
      );
    }),
  );

  it.effect("falls back to the rule on a decision that the rules reject", () =>
    Effect.gen(function* () {
      // The first child spent the one-child budget, so a replacement has no room.
      const { decision, recorded, fellBack } = yield* wake(
        answering(retry),
        requestFor("completion/rejected", true, 1),
        reported("Committed the fix, but the push failed."),
      );

      assert.isTrue(Option.isNone(decision));
      assert.isTrue(fellBack("The rules reject RetryChild"));
      assert.strictEqual(recorded.length, 1);
    }),
  );

  it.effect("falls back to the rule on a refusal", () =>
    Effect.gen(function* () {
      const { decision, recorded, fellBack } = yield* wake(
        failing(
          (sessionId) => CompletionRefused.make({ sessionId, message: "The model declined" }),
          false,
        ),
        requestFor("completion/refused"),
        reported("Opened #12."),
      );

      assert.isTrue(Option.isNone(decision));
      assert.isTrue(fellBack("CompletionRefused: The model declined"));
      assert.strictEqual(recorded.length, 0);
    }),
  );

  it.effect("falls back to the rule on a capacity error and records its usage", () =>
    Effect.gen(function* () {
      const { decision, recorded, fellBack } = yield* wake(
        failing(
          (sessionId) =>
            AgentCapacityError.make({
              sessionId: Option.some(sessionId),
              message: "You've hit your usage limit",
            }),
          true,
        ),
        requestFor("completion/capacity"),
        reported("Opened #12."),
      );

      assert.isTrue(Option.isNone(decision));
      assert.isTrue(fellBack("AgentCapacityError: You've hit your usage limit"));
      assert.strictEqual(recorded.length, 1);
    }),
  );

  it.effect("falls back to the rule on a timeout and records its usage", () =>
    Effect.gen(function* () {
      const { decision, recorded, fellBack } = yield* wake(
        failing(
          (sessionId) =>
            SessionOperationError.make({
              operation: "stream",
              sessionId: Option.some(sessionId),
              message: "claude returned no completion within 10 minutes",
              cause: new Error("completion timed out"),
            }),
          true,
        ),
        requestFor("completion/timeout"),
        reported("Opened #12."),
      );

      assert.isTrue(Option.isNone(decision));
      assert.isTrue(
        fellBack("SessionOperationError: claude returned no completion within 10 minutes"),
      );
      assert.strictEqual(recorded.length, 1);
    }),
  );

  it.effect("leaves an agent without a decision brain and a reserved report to the rule", () =>
    Effect.gen(function* () {
      const withoutBrain = yield* wake(
        answering(retry),
        requestFor("completion/no-brain", false),
        reported("Opened #12."),
      );
      const blocked = yield* wake(
        answering(retry),
        requestFor("completion/reserved"),
        reported(
          "[usine:blocked]\nNo access.",
          Option.some(ReservedReport.make({ kind: "blocked", message: "No access." })),
        ),
      );

      for (const { decision, calls, recorded } of [withoutBrain, blocked]) {
        assert.isTrue(Option.isNone(decision));
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(recorded.length, 0);
      }
      assert.isTrue(
        withoutBrain.logged.some(
          ({ level, entry }) => level === "Info" && entry.includes("has no decision brain"),
        ),
      );
    }),
  );

  it("offers one branch per ModelDecision tag", () => {
    const decision = CompletionAnswer.fields.decision;
    assert.deepStrictEqual(
      decision.members.map((member) => member.fields._tag.schema.literal),
      ["Complete", "RetryChild", "Blocked", "Question", "Failed", "InfraFailed", "AtCapacity"],
    );
  });
});

describe("coordinator with the structured completion", () => {
  it.live("completes with the completion's decision and relays its usage", () =>
    Effect.gen(function* () {
      const database = yield* temporaryDatabase;
      const request = requestFor("completion/coordinator");
      const harnesses = harnessesWith(
        answering({
          decision: { _tag: "Complete", message: "Opened #12, which closes the issue." },
          reason: "The pull request is open.",
        }),
      );
      const recording = recordingSink();
      const process = yield* orchestrator(
        sqliteJournal(database).pipe(coordinatorWith(harnesses.layer)),
      );
      const execution = yield* process.execute(request, recording.sink);
      yield* (yield* process.nextChild).reply("Opened #12.");
      const report = yield* Fiber.join(execution);
      yield* process.stop;
      const snapshot = yield* stored(database, request.spec.attemptId);
      const decisions = yield* Effect.forEach(
        Option.match(snapshot, { onNone: () => [], onSome: ({ events }) => events }),
        ({ decision }) => Schema.decodeEffect(Schema.toCodecJson(RecordedDecision))(decision),
      );
      const usage = recording
        .outbound()
        .flatMap(({ payload }) =>
          payload._tag === "SessionEvent" && payload.event._tag === "SessionTokensUpdated"
            ? [[payload.event.session.id, payload.event.totalTokens] as const]
            : [],
        );

      assert.strictEqual(report.message, "Opened #12, which closes the issue.");
      assert.deepStrictEqual(
        decisions.map(({ handler }) => handler),
        ["rule", "completion"],
      );
      assert.deepStrictEqual(usage, [
        [AgentSessionId.make("parent:completion/coordinator:decision:2"), TokenCount.make(800)],
      ]);
    }).pipe(Effect.scoped),
  );
});

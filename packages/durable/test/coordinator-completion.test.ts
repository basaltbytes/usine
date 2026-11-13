import { assert, describe, it } from "@effect/vitest";
import { catalog } from "@usine/agents/harness";
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
  ChildSessionCount,
  SessionTokensUpdated,
  TokenCount,
  UsdAmount,
} from "@usine/core/agent/session";
import * as AttemptChannel from "@usine/core/attempt/channel";
import { Effect, Fiber, Formatter, Layer, Logger, Option, Schema } from "effect";

import { AttemptRequest } from "../src/attempt-runtime.ts";
import {
  AttemptContext,
  ChildReported,
  Complete,
  ReservedReport,
  RetryChild,
} from "../src/attempt/coordinator/rules.ts";
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

/** A request whose agent decides with `DECISION_MODEL`, or without a decision brain. */
const requestFor = (attemptId: string, decision = true, maxChildren = 3) => {
  const request = coordinated(attemptId, maxChildren);
  return AttemptRequest.make({
    ...request,
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

const contextFor = (request: AttemptRequest, event: ChildReported) =>
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

/** The usage that a scripted completion reports for `spec`. */
const usageOf = (spec: SessionSpec) =>
  SessionTokensUpdated.make({
    session: spec.session,
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

/** Harness runtimes whose completions follow `script`, recording each call's spec and prompt. */
const harnessesWith = (script: Script) => {
  const calls: Array<{ readonly spec: SessionSpec; readonly prompt: string }> = [];
  const runtimes = catalog.ids.map((id): HarnessRuntime => ({
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
      Layer.provide(Harnesses.layerFrom(catalog, runtimes).pipe(Layer.orDie)),
    ),
  };
};

/** Wakes the completion handler for `event` and returns its answer and the usage it recorded. */
const wake = (script: Script, request: AttemptRequest, event: ChildReported) =>
  Effect.gen(function* () {
    const harnesses = harnessesWith(script);
    const recorded: Array<SessionTokensUpdated> = [];
    const logged: Array<string> = [];
    const logger = Logger.layer([
      Logger.make(({ message }) => logged.push(Formatter.format(message))),
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
    /** Whether the handler logged that the rule applies because of `reason`. */
    const fellBack = (reason: string) =>
      logged.some((entry) => entry.includes("its rule applies") && entry.includes(reason));
    return { decision, recorded, calls: harnesses.calls, fellBack };
  });

const retry = {
  decision: { _tag: "RetryChild", assignment: "Push the branch you committed." },
  reason: "The report says the branch isn't pushed.",
};

describe("structured completion wake-up", () => {
  it.effect("records a valid decision with the completion's brain, route, pool, and usage", () =>
    Effect.gen(function* () {
      const request = requestFor("completion/valid");
      const { decision, recorded, calls } = yield* wake(
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

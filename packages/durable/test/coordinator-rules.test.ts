import { assert, describe, expect, it } from "@effect/vitest";
import { AgentName } from "@usine/core/agent";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { RepositoryName } from "@usine/core/repository";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { DateTime, Effect, Exit, Option, Schema } from "effect";
import {
  apply,
  AtCapacity,
  AttemptContext,
  AttemptStarted,
  AwaitingStart,
  BLANK_REPORT_MESSAGE,
  Blocked,
  BudgetExceeded,
  ChildAtCapacity,
  ChildFailed,
  ChildInterrupted,
  ChildReported,
  clamp,
  Complete,
  type CoordinatorEvent,
  CoordinatorState,
  Decision,
  EffectIntent,
  Failed,
  FIRST_ASSIGNMENT,
  InfraFailed,
  ModelDecision,
  Question,
  REPLACEMENT_ASSIGNMENT,
  REPORTED_REPLACEMENT_ASSIGNMENT,
  type ReservedKind,
  ReservedReport,
  RetryChild,
  ruleFor,
} from "../src/attempt/coordinator/rules.ts";

const child = ChildSessionCount.make;

const contextFor = (event: CoordinatorEvent, maxChildren = 3) =>
  AttemptContext.make({
    event,
    maxChildren: ChildSessionBudget.make(maxChildren),
    repository: RepositoryName.make("basaltbytes/usine"),
    agent: AgentName.make("developer"),
    task: "Fix the flaky durable test.",
    outcomeLabels: [],
    requiresCi: false,
    delegations: [],
    output: "",
  });

/** Handles `event` as the coordinator does: the rule unless `decision` is given, then clamp and apply. */
const handle = (
  state: CoordinatorState,
  event: CoordinatorEvent,
  options: { readonly maxChildren?: number; readonly decision?: Decision } = {},
) => {
  const context = contextFor(event, options.maxChildren);
  return apply(state, clamp(options.decision ?? ruleFor(event, context), context));
};

const startedState = () => handle(AwaitingStart.make({}), AttemptStarted.make({}))[0];

const reported = (report: string, answeredOperator = false) =>
  ChildReported.make({ child: child(1), report, answeredOperator, reserved: Option.none() });

const reservedReport = (kind: ReservedKind, message: string) =>
  ChildReported.make({
    child: child(1),
    report: `[usine:${kind}]\n${message}`,
    answeredOperator: false,
    reserved: Option.some(ReservedReport.make({ kind, message })),
  });

const encodeFailure = Schema.encodeEffect(AttemptFailure);
const encodeIntent = Schema.encodeEffect(EffectIntent);
type EncodedFailure = typeof AttemptFailure.Encoded;

const failureMessage = (intent: { readonly failed?: EncodedFailure }) =>
  intent.failed !== undefined && "message" in intent.failed ? intent.failed.message : "";

/** Returns the single intent, with a failure encoded so it compares as plain data. */
const intentOf = Effect.fn("intentOf")(function* (intents: ReadonlyArray<EffectIntent>) {
  assert.strictEqual(intents.length, 1);
  const [intent] = intents;
  if (intent === undefined) return assert.fail("expected one intent");
  if (intent._tag === "Delegate")
    return { delegate: Number(intent.child), assignment: intent.assignment };
  if (intent._tag === "Ignored") {
    const encoded = yield* encodeIntent(intent);
    if (encoded._tag !== "Ignored") return assert.fail("expected an Ignored intent");
    return { ignored: encoded.reason };
  }
  if (intent.outcome._tag === "AttemptCompleted") return { completed: intent.outcome };
  const failure = yield* encodeFailure(intent.outcome.failure);
  return { failed: failure };
});

describe("coordinator rules", () => {
  it.effect("AttemptStarted delegates child 1 with the fixed context", () =>
    Effect.gen(function* () {
      const [state, intents] = handle(AwaitingStart.make({}), AttemptStarted.make({}));
      assert.strictEqual(state._tag, "Delegating");
      const intent = yield* intentOf(intents);
      assert.deepStrictEqual(intent, { delegate: 1, assignment: FIRST_ASSIGNMENT });
    }),
  );

  it.effect("ChildReported with a reserved marker fails with the mapped failure", () =>
    Effect.gen(function* () {
      const expected: ReadonlyArray<readonly [ReservedKind, EncodedFailure]> = [
        ["blocked", { _tag: "BlockedFailure", message: "No token" }],
        ["question", { _tag: "QuestionFailure", question: "No token" }],
        ["failed", { _tag: "AgentFailure", message: "No token" }],
      ];
      for (const [kind, failure] of expected) {
        const [state, intents] = handle(startedState(), reservedReport(kind, "No token"));
        assert.strictEqual(state._tag, "Settled", kind);
        const intent = yield* intentOf(intents);
        assert.deepStrictEqual(intent, { failed: failure }, kind);
      }
    }),
  );

  it.effect("ChildReported without a marker completes with the report", () =>
    Effect.gen(function* () {
      for (const answeredOperator of [false, true]) {
        const [, intents] = handle(startedState(), reported("Opened #12", answeredOperator));
        const intent = yield* intentOf(intents);
        assert.deepStrictEqual(intent, {
          completed: { _tag: "AttemptCompleted", message: "Opened #12", answeredOperator },
        });
      }
      const [, blank] = handle(startedState(), reported(" \n"));
      const intent = yield* intentOf(blank);
      assert.deepStrictEqual(intent, {
        completed: {
          _tag: "AttemptCompleted",
          message: BLANK_REPORT_MESSAGE,
          answeredOperator: false,
        },
      });
    }),
  );

  it.effect("ChildInterrupted delegates one replacement in the next budget slot", () =>
    Effect.gen(function* () {
      const [state, intents] = handle(
        startedState(),
        ChildInterrupted.make({ child: child(1), reason: "no saved session" }),
      );
      assert.strictEqual(state._tag === "Delegating" && Number(state.child), 2);
      const intent = yield* intentOf(intents);
      assert.deepStrictEqual(intent, { delegate: 2, assignment: REPLACEMENT_ASSIGNMENT });
    }),
  );

  it.effect("ChildInterrupted fails with an infrastructure failure when no slot is left", () =>
    Effect.gen(function* () {
      const [, intents] = handle(
        startedState(),
        ChildInterrupted.make({ child: child(1), reason: "worker gone" }),
        { maxChildren: 1 },
      );
      const intent = yield* intentOf(intents);
      assert.strictEqual("failed" in intent && intent.failed._tag, "InfraFailure");
      assert.include(failureMessage(intent), "worker gone");
    }),
  );

  it.effect(
    "ChildAtCapacity, ChildFailed, and BudgetExceeded fail with their failures, keeping resetsAt",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<readonly [CoordinatorEvent, EncodedFailure]> = [
          [
            ChildAtCapacity.make({ child: child(1), message: "HTTP 529", resetsAt: Option.none() }),
            { _tag: "ProviderCapacityFailure", message: "HTTP 529" },
          ],
          [
            ChildAtCapacity.make({
              child: child(1),
              message: "Usage limit reached",
              resetsAt: Option.some(DateTime.makeUnsafe("2026-11-11T18:00:00Z")),
            }),
            {
              _tag: "ProviderCapacityFailure",
              message: "Usage limit reached",
              resetsAt: "2026-11-11T18:00:00.000Z",
            },
          ],
          [
            ChildFailed.make({ child: child(1), message: "ssh: closed" }),
            { _tag: "InfraFailure", message: "ssh: closed", cause: "ssh: closed" },
          ],
          [
            BudgetExceeded.make({ child: child(1), attempted: child(3) }),
            { _tag: "ChildSessionBudgetFailure", maxChildren: 2, attemptedChildren: 3 },
          ],
        ];
        for (const [event, failure] of cases) {
          const [, intents] = handle(startedState(), event, { maxChildren: 2 });
          const intent = yield* intentOf(intents);
          assert.deepStrictEqual(intent, { failed: failure }, event._tag);
        }
      }),
  );

  it("clamp keeps every typed fact's rule over a model's decision", () => {
    const events: ReadonlyArray<CoordinatorEvent> = [
      reservedReport("question", "Which base branch?"),
      ChildAtCapacity.make({ child: child(1), message: "HTTP 529", resetsAt: Option.none() }),
      ChildFailed.make({ child: child(1), message: "ssh: closed" }),
      BudgetExceeded.make({ child: child(1), attempted: child(4) }),
    ];
    for (const event of events) {
      const context = contextFor(event);
      assert.deepStrictEqual(
        clamp(Complete.make({ message: "Done" }), context),
        clamp(ruleFor(event, context), context),
        event._tag,
      );
    }
  });

  it.effect("clamp honors a model's decision about a report without a marker", () =>
    Effect.gen(function* () {
      const event = reported("API Error: Request rejected (429)");
      const cases: ReadonlyArray<readonly [Decision, EncodedFailure]> = [
        [Blocked.make({}), { _tag: "BlockedFailure", message: event.report }],
        [
          Question.make({ question: "Retry later?" }),
          { _tag: "QuestionFailure", question: "Retry later?" },
        ],
        [Failed.make({ message: "Rejected" }), { _tag: "AgentFailure", message: "Rejected" }],
        [
          InfraFailed.make({ message: "Transport lost" }),
          { _tag: "InfraFailure", message: "Transport lost", cause: "Transport lost" },
        ],
        [
          AtCapacity.make({ message: "HTTP 429" }),
          { _tag: "ProviderCapacityFailure", message: "HTTP 429" },
        ],
      ];
      for (const [decision, failure] of cases) {
        const [, intents] = handle(startedState(), event, { decision });
        const intent = yield* intentOf(intents);
        assert.deepStrictEqual(intent, { failed: failure }, decision._tag);
      }
      const [, retried] = handle(startedState(), event, {
        decision: RetryChild.make({ assignment: "Push the branch you committed." }),
      });
      const intent = yield* intentOf(retried);
      assert.deepStrictEqual(intent, { delegate: 2, assignment: "Push the branch you committed." });
    }),
  );

  it("clamp keeps an interruption's rule over every model decision, so it never completes", () => {
    const event = ChildInterrupted.make({ child: child(1), reason: "worker gone" });
    const decisions: ReadonlyArray<Decision> = [
      Complete.make({ message: "The pull request already merged" }),
      Complete.make({}),
      Failed.make({ message: "The checkout is gone" }),
      Blocked.make({}),
      RetryChild.make({ assignment: "Rebuild the checkout first." }),
    ];
    for (const maxChildren of [1, 3]) {
      const context = contextFor(event, maxChildren);
      const rule = clamp(ruleFor(event, context), context);
      for (const decision of decisions) {
        const resolved = clamp(decision, context);
        assert.deepStrictEqual(resolved, rule, `${maxChildren} ${decision._tag}`);
        assert.notStrictEqual(
          resolved._tag === "Settle" && resolved.outcome._tag,
          "AttemptCompleted",
          `${maxChildren} ${decision._tag}`,
        );
      }
    }
  });

  it.effect("clamp fills a model's missing free text from the event it answers", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [CoordinatorEvent, Decision, object]> = [
        [
          reported("API Error: Request rejected (429)\n"),
          RetryChild.make({}),
          {
            delegate: 2,
            assignment: `${REPORTED_REPLACEMENT_ASSIGNMENT}\n\nAPI Error: Request rejected (429)`,
          },
        ],
        [
          reported(" \n"),
          RetryChild.make({}),
          {
            delegate: 2,
            assignment: `${REPORTED_REPLACEMENT_ASSIGNMENT}\n\n${BLANK_REPORT_MESSAGE}`,
          },
        ],
      ];
      for (const [event, decision, expected] of cases) {
        const [, intents] = handle(startedState(), event, { decision });
        const intent = yield* intentOf(intents);
        assert.deepStrictEqual(intent, expected, event._tag);
      }
    }),
  );

  it("clamp applies the event's rule to a rule-only tag about a child", () => {
    const ruleOnly = [
      ruleFor(AttemptStarted.make({}), contextFor(AttemptStarted.make({}))),
      ruleFor(
        BudgetExceeded.make({ child: child(1), attempted: child(7) }),
        contextFor(AttemptStarted.make({})),
      ),
    ];
    assert.deepStrictEqual(
      ruleOnly.map((decision) => decision._tag),
      ["StartChild", "OverBudget"],
    );
    const events = [
      reported("Opened #12"),
      ChildInterrupted.make({ child: child(1), reason: "restart" }),
    ];
    for (const event of events) {
      const context = contextFor(event);
      for (const decision of ruleOnly)
        assert.deepStrictEqual(
          clamp(decision, context),
          clamp(ruleFor(event, context), context),
          `${event._tag} ${decision._tag}`,
        );
    }
  });

  it("ModelDecision rejects the tags only a rule makes", () => {
    for (const answer of [{ _tag: "StartChild" }, { _tag: "OverBudget", attempted: 7 }])
      assert.isTrue(Exit.isFailure(Schema.decodeUnknownExit(ModelDecision)(answer)), answer._tag);
  });

  it.effect("clamp turns RetryChild past the budget into Failed", () =>
    Effect.gen(function* () {
      const [, intents] = handle(startedState(), reported("Half done"), {
        maxChildren: 1,
        decision: RetryChild.make({}),
      });
      const intent = yield* intentOf(intents);
      assert.strictEqual("failed" in intent && intent.failed._tag, "AgentFailure");
      assert.include(failureMessage(intent), "1-child budget");
    }),
  );

  it.effect("allows at most one replacement per interruption", () =>
    Effect.gen(function* () {
      const interrupted = ChildInterrupted.make({ child: child(1), reason: "restart" });
      const context = contextFor(interrupted);
      const decision = clamp(ruleFor(interrupted, context), context);
      const [replaced, first] = apply(startedState(), decision);
      const [again, second] = apply(replaced, decision);
      assert.strictEqual(first.length, 1);
      const stale = { ignored: { _tag: "StaleChild", answering: 1, latest: 2 } } as const;
      const repeated = yield* intentOf(second);
      assert.deepStrictEqual(repeated, stale);
      assert.strictEqual(again, replaced);
      const [late, staleReport] = handle(replaced, reported("Stale"));
      const lateIntent = yield* intentOf(staleReport);
      assert.deepStrictEqual(lateIntent, stale);
      assert.strictEqual(late, replaced);
    }),
  );

  it("never delegates past the budget however often children are interrupted", () => {
    for (let maxChildren = 1; maxChildren <= 4; maxChildren += 1) {
      let [state] = handle(AwaitingStart.make({}), AttemptStarted.make({}));
      const delegated = [1];
      while (state._tag === "Delegating") {
        const event = ChildInterrupted.make({ child: state.child, reason: "restart" });
        const [next, intents] = handle(state, event, { maxChildren });
        for (const intent of intents) if (intent._tag === "Delegate") delegated.push(intent.child);
        state = next;
      }
      assert.deepStrictEqual(
        delegated,
        Array.from({ length: maxChildren }, (_, index) => index + 1),
      );
    }
  });

  it.effect("ignores a repeated start and every decision after the Attempt settles", () =>
    Effect.gen(function* () {
      const started = startedState();
      const [restarted, repeated] = handle(started, AttemptStarted.make({}));
      assert.strictEqual(restarted, started);
      const repeatedIntent = yield* intentOf(repeated);
      assert.deepStrictEqual(repeatedIntent, { ignored: { _tag: "AlreadyStarted" } });
      const [settled] = handle(started, reported("Done"));
      for (const event of [AttemptStarted.make({}), reported("Again")]) {
        const [next, intents] = handle(settled, event);
        assert.strictEqual(next, settled, event._tag);
        const intent = yield* intentOf(intents);
        assert.deepStrictEqual(intent, { ignored: { _tag: "AttemptSettled" } }, event._tag);
      }
    }),
  );

  it.effect("ignores a decision about a child before the first child starts", () =>
    Effect.gen(function* () {
      const events = [
        reported("Done"),
        ChildInterrupted.make({ child: child(1), reason: "restart" }),
      ];
      for (const event of events) {
        const awaiting = AwaitingStart.make({});
        const [next, intents] = handle(awaiting, event);
        assert.strictEqual(next, awaiting, event._tag);
        const intent = yield* intentOf(intents);
        assert.deepStrictEqual(
          intent,
          { ignored: { _tag: "NotStarted", answering: 1 } },
          event._tag,
        );
      }
    }),
  );

  it.effect("describes ModelDecision as a JSON Schema with one branch per tag", () =>
    Effect.gen(function* () {
      const document = Schema.toJsonSchemaDocument(ModelDecision);
      const { anyOf } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          anyOf: Schema.Array(
            Schema.Struct({
              properties: Schema.Struct({
                _tag: Schema.Struct({ enum: Schema.Array(Schema.String) }),
              }),
            }),
          ),
        }),
      )(document.schema);
      assert.deepStrictEqual(
        anyOf.map((branch) => branch.properties._tag.enum),
        ModelDecision.members.map((member) => [member.fields._tag.schema.literal]),
      );
      expect(document).toMatchInlineSnapshot(`
        {
          "definitions": {},
          "dialect": "draft-2020-12",
          "schema": {
            "anyOf": [
              {
                "additionalProperties": true,
                "properties": {
                  "_tag": {
                    "enum": [
                      "Complete",
                    ],
                    "type": "string",
                  },
                  "message": {
                    "minLength": 1,
                    "type": "string",
                  },
                },
                "required": [
                  "_tag",
                ],
                "type": "object",
              },
              {
                "additionalProperties": true,
                "properties": {
                  "_tag": {
                    "enum": [
                      "RetryChild",
                    ],
                    "type": "string",
                  },
                  "assignment": {
                    "minLength": 1,
                    "type": "string",
                  },
                },
                "required": [
                  "_tag",
                ],
                "type": "object",
              },
              {
                "additionalProperties": true,
                "properties": {
                  "_tag": {
                    "enum": [
                      "Blocked",
                    ],
                    "type": "string",
                  },
                  "message": {
                    "minLength": 1,
                    "type": "string",
                  },
                },
                "required": [
                  "_tag",
                ],
                "type": "object",
              },
              {
                "additionalProperties": true,
                "properties": {
                  "_tag": {
                    "enum": [
                      "Question",
                    ],
                    "type": "string",
                  },
                  "question": {
                    "minLength": 1,
                    "type": "string",
                  },
                },
                "required": [
                  "_tag",
                  "question",
                ],
                "type": "object",
              },
              {
                "additionalProperties": true,
                "properties": {
                  "_tag": {
                    "enum": [
                      "Failed",
                    ],
                    "type": "string",
                  },
                  "message": {
                    "minLength": 1,
                    "type": "string",
                  },
                },
                "required": [
                  "_tag",
                  "message",
                ],
                "type": "object",
              },
              {
                "additionalProperties": true,
                "properties": {
                  "_tag": {
                    "enum": [
                      "InfraFailed",
                    ],
                    "type": "string",
                  },
                  "message": {
                    "minLength": 1,
                    "type": "string",
                  },
                },
                "required": [
                  "_tag",
                  "message",
                ],
                "type": "object",
              },
              {
                "additionalProperties": true,
                "properties": {
                  "_tag": {
                    "enum": [
                      "AtCapacity",
                    ],
                    "type": "string",
                  },
                  "message": {
                    "minLength": 1,
                    "type": "string",
                  },
                  "resetsAt": {
                    "type": "string",
                  },
                },
                "required": [
                  "_tag",
                  "message",
                ],
                "type": "object",
              },
            ],
          },
        }
      `);
    }),
  );

  it.effect("round-trips each state through the JSON committed with a transition", () =>
    Effect.gen(function* () {
      const json = Schema.fromJsonString(CoordinatorState);
      const states = [
        AwaitingStart.make({}),
        startedState(),
        handle(startedState(), ChildFailed.make({ child: child(1), message: "ssh: closed" }))[0],
      ];
      for (const state of states) {
        const encoded = yield* Schema.encodeEffect(json)(state);
        const decoded = yield* Schema.decodeEffect(json)(encoded);
        assert.deepStrictEqual(decoded, state);
      }
    }),
  );
});

import { assert, describe, expect, it } from "@effect/vitest";
import { ChildSessionBudget, ChildSessionCount } from "@usine/core/agent/session";
import { AttemptFailure } from "@usine/core/attempt/failure";
import { Effect, Option, Schema } from "effect";
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
  type EffectIntent,
  Failed,
  FIRST_ASSIGNMENT,
  InfraFailed,
  Question,
  REPLACEMENT_ASSIGNMENT,
  type ReservedKind,
  ReservedReport,
  RetryChild,
  ruleFor,
} from "../src/attempt/coordinator/rules.ts";

const child = ChildSessionCount.make;

const contextFor = (event: CoordinatorEvent, maxChildren = 3) =>
  AttemptContext.make({ event, maxChildren: ChildSessionBudget.make(maxChildren) });

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

  it.effect("ChildAtCapacity, ChildFailed, and BudgetExceeded fail with their failures", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [CoordinatorEvent, EncodedFailure]> = [
        [
          ChildAtCapacity.make({ child: child(1), message: "HTTP 529" }),
          { _tag: "ProviderCapacityFailure", message: "HTTP 529" },
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
      ChildAtCapacity.make({ child: child(1), message: "HTTP 529" }),
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

  it("allows at most one replacement per interruption", () => {
    const interrupted = ChildInterrupted.make({ child: child(1), reason: "restart" });
    const context = contextFor(interrupted);
    const decision = clamp(ruleFor(interrupted, context), context);
    const [replaced, first] = apply(startedState(), decision);
    const [again, second] = apply(replaced, decision);
    assert.strictEqual(first.length, 1);
    assert.deepStrictEqual(second, []);
    assert.strictEqual(again, replaced);
    const [late, stale] = handle(replaced, reported("Stale"));
    assert.deepStrictEqual(stale, []);
    assert.strictEqual(late, replaced);
  });

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

  it("ignores a repeated start and every decision after the Attempt settles", () => {
    const started = startedState();
    assert.deepStrictEqual(handle(started, AttemptStarted.make({})), [started, []]);
    const [settled] = handle(started, reported("Done"));
    for (const event of [AttemptStarted.make({}), reported("Again")])
      assert.deepStrictEqual(handle(settled, event), [settled, []]);
  });

  it.effect("describes Decision as a JSON Schema with one branch per tag", () =>
    Effect.gen(function* () {
      const document = Schema.toJsonSchemaDocument(Decision);
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
        Decision.members.map((member) => [member.fields._tag.schema.literal]),
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
                      "StartChild",
                    ],
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
                      "OverBudget",
                    ],
                    "type": "string",
                  },
                  "attempted": {
                    "maximum": 9007199254740991,
                    "minimum": 1,
                    "type": "integer",
                  },
                },
                "required": [
                  "_tag",
                  "attempted",
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

import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { ExpressionEngine, Source } from "../src/expression-engine.ts";
import { MarcbachmannCelLayer } from "../src/marcbachmann-cel.ts";
import {
  Environment,
  ObjectField,
  ObjectType,
  TypeReference,
  Variable,
} from "../src/environment.ts";

const typeReference = Schema.decodeUnknownSync(TypeReference);
const source = Schema.decodeUnknownSync(Source);

const issueEnvironment = new Environment({
  types: [
    new ObjectType({
      name: "Label",
      fields: [new ObjectField({ name: "name", type: typeReference("string") })],
    }),
    new ObjectType({
      name: "Labels",
      fields: [
        new ObjectField({ name: "totalCount", type: typeReference("int") }),
        new ObjectField({ name: "nodes", type: typeReference("list<Label>") }),
      ],
    }),
    new ObjectType({
      name: "Issue",
      fields: [
        new ObjectField({ name: "state", type: typeReference("string") }),
        new ObjectField({ name: "labels", type: typeReference("Labels") }),
      ],
    }),
  ],
  variables: [new Variable({ name: "item", type: typeReference("Issue") })],
});

const nullableEnvironment = new Environment({
  types: [
    new ObjectType({
      name: "Milestone",
      fields: [new ObjectField({ name: "title", type: typeReference("string") })],
    }),
    new ObjectType({
      name: "Reviewer",
      fields: [new ObjectField({ name: "login", type: typeReference("string"), nullable: true })],
    }),
    new ObjectType({
      name: "PullRequest",
      fields: [
        new ObjectField({ name: "number", type: typeReference("int") }),
        new ObjectField({ name: "reviewDecision", type: typeReference("string"), nullable: true }),
        new ObjectField({ name: "milestone", type: typeReference("Milestone"), nullable: true }),
        new ObjectField({ name: "reviewers", type: typeReference("list<Reviewer>") }),
        new ObjectField({ name: "annotations", type: typeReference("map<string,string>") }),
        new ObjectField({ name: "reviewersByRole", type: typeReference("map<string,Reviewer>") }),
        new ObjectField({ name: "counts", type: typeReference("map<string,int>") }),
      ],
    }),
  ],
  variables: [new Variable({ name: "item", type: typeReference("PullRequest") })],
});

const withNulls = {
  item: { number: 7, reviewDecision: null, milestone: null, reviewers: [{}], annotations: {} },
};
const withValues = {
  item: {
    number: 7,
    reviewDecision: "APPROVED",
    milestone: { title: "v1" },
    reviewers: [{ login: "octocat" }],
    annotations: { team: "core" },
  },
};

describe("ExpressionEngine", () => {
  it.effect("evaluates typed JSON map values with nullable fields and integer arithmetic", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const context = {
        item: {
          reviewersByRole: Object.fromEntries([
            ["__proto__", {}],
            ["owner", { login: "octocat" }],
          ]),
          counts: { reviews: 2 },
        },
      };
      expect(
        yield* engine.evaluateBoolean(
          source(
            'item.reviewersByRole["__proto__"].login == null && ' +
              'item.reviewersByRole["owner"].login == "octocat" && item.counts["reviews"] + 1 == 3',
          ),
          nullableEnvironment,
          context,
        ),
      ).toBe(true);
      const typo = yield* Effect.flip(
        engine.checkBoolean(
          source('item.reviewersByRole["owner"].logni == "octocat"'),
          nullableEnvironment,
        ),
      );
      expect(typo.code).toBe("type_error");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("compares nullable fields with null and evaluates reads of them on null", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const cases = [
        ['item.reviewDecision == "APPROVED"', false, true],
        ["item.reviewDecision != null", false, true],
        ["null == item.milestone", true, false],
        ['item.milestone != null && item.milestone.title == "v1"', false, true],
        ["has(item.milestone.title)", false, true],
        ["item.reviewers.exists(reviewer, reviewer.login == null)", true, false],
      ] as const;
      for (const [expression, onNulls, onValues] of cases) {
        expect(
          [
            yield* engine.evaluateBoolean(source(expression), nullableEnvironment, withNulls),
            yield* engine.evaluateBoolean(source(expression), nullableEnvironment, withValues),
          ],
          expression,
        ).toEqual([onNulls, onValues]);
      }
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("keeps reads below a nullable field typed and fails them on null", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const typo = yield* engine
        .checkBoolean(source('item.milestone.titel == "v1"'), nullableEnvironment)
        .pipe(Effect.flip);
      const mismatch = yield* engine
        .checkBoolean(source("item.reviewDecision + 1 == 2"), nullableEnvironment)
        .pipe(Effect.flip);
      const belowNull = yield* engine
        .evaluateBoolean(source('item.milestone.title == "v1"'), nullableEnvironment, withNulls)
        .pipe(Effect.flip);

      expect(typo.code).toBe("type_error");
      expect(typo.message).toContain("No such key: titel");
      expect(mismatch.code).toBe("type_error");
      expect(belowNull._tag).toBe("ExpressionEvaluationError");
      expect(belowNull.message).toContain("No such key: title");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("interpolates null and nullable scalars but not a nullable object", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      yield* engine.checkScalar(source("null"), nullableEnvironment);
      const decision = source("item.reviewDecision");
      expect(yield* engine.evaluateScalar(decision, nullableEnvironment, withNulls)).toBeNull();
      expect(yield* engine.evaluateScalar(decision, nullableEnvironment, withValues)).toBe(
        "APPROVED",
      );
      const object = yield* engine
        .checkScalar(source("item.milestone"), nullableEnvironment)
        .pipe(Effect.flip);
      expect(object.message).toBe("Expected a scalar value, got Milestone");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("falls back through optional selection on a missing milestone or map key", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const withoutKeys = { item: { number: 7, reviewers: [], annotations: {} } };
      const cases = [
        ['item.?milestone.?title.orValue("none")', "none", "v1"],
        ['item.annotations.?team.orValue("none")', "none", "core"],
      ] as const;
      for (const [expression, missing, present] of cases) {
        expect(
          yield* Effect.forEach([withNulls, withoutKeys, withValues], (context) =>
            engine.evaluateScalar(source(expression), nullableEnvironment, context),
          ),
          expression,
        ).toEqual([missing, missing, present]);
      }
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("checks and evaluates a typed expression over plain JSON", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const expression = source(
        'item.state == "OPEN" && item.labels.nodes.exists(label, label.name == "ready")',
      );

      yield* engine.checkBoolean(expression, issueEnvironment);
      const matches = yield* engine.evaluateBoolean(expression, issueEnvironment, {
        item: {
          state: "OPEN",
          labels: { totalCount: 1, nodes: [{ name: "ready" }] },
        },
      });

      expect(matches).toBe(true);
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("evaluates the same expression again on each new context", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const expression = source(
        'item.labels.totalCount > 0 && item.labels.nodes.exists(label, label.name == "ready")',
      );
      const labelled = (names: ReadonlyArray<string>) => ({
        item: {
          state: "OPEN",
          labels: { totalCount: names.length, nodes: names.map((name) => ({ name })) },
        },
      });

      const matches = yield* Effect.forEach(
        [["ready"], [], ["bug", "ready"], ["bug"], ["ready"]],
        (names) => engine.evaluateBoolean(expression, issueEnvironment, labelled(names)),
      );

      expect(matches).toEqual([true, false, true, false, true]);
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("evaluates one condition on each context and keeps each failure to its context", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const results = yield* engine.evaluateBooleanEach(
        source('item.milestone.title == "v1"'),
        nullableEnvironment,
        [withValues, withNulls, { item: { ...withValues.item, milestone: { title: "v2" } } }],
      );

      expect(
        results.map((result) => (Result.isSuccess(result) ? result.success : "failed")),
      ).toEqual([true, "failed", false]);
      const failure = results[1];
      expect(failure !== undefined && Result.isFailure(failure) ? failure.failure._tag : null).toBe(
        "ExpressionEvaluationError",
      );
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("fails the whole evaluation of each context when the condition does not check", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const failure = yield* engine
        .evaluateBooleanEach(source("item.state"), issueEnvironment, [
          { item: { state: "OPEN", labels: { totalCount: 0, nodes: [] } } },
        ])
        .pipe(Effect.flip);

      expect(failure.code).toBe("unexpected_result_type");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("finds label-related string literals without treating state literals as labels", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const labels = yield* engine.relatedStringLiterals(
        source('item.labels.nodes.exists(label, label.name == "ready" && item.state == "OPEN")'),
        ["item", "labels"],
      );

      expect(labels).toEqual(["ready"]);

      const noLabelLiteral = yield* engine.relatedStringLiterals(
        source('item.labels.totalCount > 0 && item.state == "OPEN"'),
        ["item", "labels"],
      );
      expect(noLabelLiteral).toEqual([]);

      const chainedMacroLabels = yield* engine.relatedStringLiterals(
        source('item.labels.nodes.map(label, label.name).exists(name, name == "missing-chained")'),
        ["item", "labels"],
      );
      expect(chainedMacroLabels).toEqual(["missing-chained"]);

      const unrelatedProjection = yield* engine.relatedStringLiterals(
        source('item.labels.nodes.map(label, item.state).exists(state, state == "OPEN")'),
        ["item", "labels"],
      );
      expect(unrelatedProjection).toEqual([]);

      const conditionalResult = yield* engine.relatedStringLiterals(
        source(
          'item.labels.nodes.exists(label, label.name == (item.state == "OPEN" ? "ready" : "review"))',
        ),
        ["item", "labels"],
      );
      expect(conditionalResult).toEqual(["ready", "review"]);

      const membership = yield* engine.relatedStringLiterals(
        source('item.labels.nodes.exists(label, label.name in ["ready", "review"])'),
        ["item", "labels"],
      );
      expect(membership).toEqual(["ready", "review"]);

      const optionalSelection = yield* engine.relatedStringLiterals(
        source(
          'item.?milestone.?title.orValue("none") == "v1" && item.labels.nodes.exists(label, label.name == "ready")',
        ),
        ["item", "labels"],
      );
      expect(optionalSelection).toEqual(["ready"]);
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("rejects unknown variables and paths inside macro bodies during checking", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const unknownPath = yield* engine
        .checkBoolean(
          source('item.labels.nodes.exists(label, label.nmae == "ready")'),
          issueEnvironment,
        )
        .pipe(Effect.flip);
      const unknownVariable = yield* engine
        .checkBoolean(source('missing.state == "OPEN"'), issueEnvironment)
        .pipe(Effect.flip);

      expect(unknownPath.code).toBe("type_error");
      expect(unknownPath.message).toContain("No such key: nmae");
      expect(unknownPath.position._tag).toBe("Some");
      expect(unknownVariable.code).toBe("type_error");
      expect(unknownVariable.message).toContain("Unknown variable: missing");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("rejects incompatible operand types during checking", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const failure = yield* engine
        .checkBoolean(source("item.state > 1"), issueEnvironment)
        .pipe(Effect.flip);

      expect(failure.code).toBe("type_error");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("rejects a non-boolean selection expression before evaluation", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const failure = yield* engine
        .checkBoolean(source("item.state"), issueEnvironment)
        .pipe(Effect.flip);

      expect(failure.code).toBe("unexpected_result_type");
      expect(failure.message).toBe("Expected bool, got string");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("rejects a structured result where prompt interpolation expects a scalar", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const failure = yield* engine
        .checkScalar(source("item.labels.nodes"), issueEnvironment)
        .pipe(Effect.flip);

      expect(failure.code).toBe("unexpected_result_type");
      expect(failure.message).toBe("Expected a scalar value, got list<Label>");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );

  it.effect("translates parser failures into a backend-neutral check error", () =>
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      const failure = yield* engine
        .checkBoolean(source("item.state =="), issueEnvironment)
        .pipe(Effect.flip);

      expect(failure.code).toBe("parse_error");
      expect(failure.position._tag).toBe("Some");
    }).pipe(Effect.provide(MarcbachmannCelLayer)),
  );
});

it.effect("checks integer result types and preserves signed integer evaluation", () =>
  Effect.gen(function* () {
    const engine = yield* ExpressionEngine;
    expect(yield* engine.evaluateInteger(source("-1"), issueEnvironment, {})).toBe(-1n);
    expect(yield* engine.evaluateInteger(source("9007199254740992"), issueEnvironment, {})).toBe(
      9007199254740992n,
    );
    for (const value of ["true", "1.0", "1u", '"1"', "[]"])
      expect(
        (yield* engine.checkInteger(source(value), issueEnvironment).pipe(Effect.flip)).code,
      ).toBe("unexpected_result_type");
    expect(
      (yield* engine.evaluateInteger(source("1 / 0"), issueEnvironment, {}).pipe(Effect.flip))._tag,
    ).toBe("ExpressionEvaluationError");
  }).pipe(Effect.provide(MarcbachmannCelLayer)),
);

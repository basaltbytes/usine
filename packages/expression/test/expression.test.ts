import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ExpressionEngine } from "../src/expression-engine.ts";
import { MarcbachmannCelLayer } from "../src/marcbachmann-cel.ts";
import {
  Environment,
  ObjectField,
  ObjectType,
  Source,
  TypeReference,
  Variable,
} from "../src/model.ts";

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

describe("ExpressionEngine", () => {
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

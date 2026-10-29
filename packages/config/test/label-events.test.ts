import { expect, it } from "@effect/vitest";
import { ExpressionEngine, Source } from "@usine/expression/expression-engine";
import { MarcbachmannCelLayer } from "@usine/expression/marcbachmann-cel";
import { Effect, Layer } from "effect";
import { InstancePath } from "../src/file.ts";
import { ConfigParser } from "../src/parser.ts";
import { environmentFor } from "../src/payload-slices.ts";

const appSetLabel = Source.make(`
  item.state == "OPEN" &&
  "ready-for-agent" in item.labelEvents &&
  item.labelEvents["ready-for-agent"].actor != null &&
  item.labelEvents["ready-for-agent"].actor.type == "Bot" &&
  item.labelEvents["ready-for-agent"].actor.login == "your-app-slug"
`);

for (const stream of ["issue", "pr"] as const) {
  it.effect(
    `selects App-set labels for approval in ${stream} loops and checks provenance fields`,
    () =>
      Effect.gen(function* () {
        const engine = yield* ExpressionEngine;
        const parser = yield* ConfigParser;
        const loop = yield* parser.parseLoopFile(
          InstancePath.make("loops/app-label.md"),
          `---\ntrigger:\n  on: ${stream}\n  if: >-\n${appSetLabel
            .trim()
            .split("\n")
            .map((line) => `    ${line.trim()}`)
            .join("\n")}\napproval: required\nagent: developer\n---\nHandle #{{ item.number }}.`,
        );
        expect(loop.approval).toBe("required");
        const environment = environmentFor(stream);
        for (const [actor, expected] of [
          [{ login: "your-app-slug", type: "Bot" }, true],
          [{ login: "other-app", type: "Bot" }, false],
          [{ login: "your-app-slug", type: "User" }, false],
          [null, false],
        ] as const) {
          expect(
            yield* engine.evaluateBoolean(appSetLabel, environment, {
              item: {
                state: "OPEN",
                labelEvents: {
                  "ready-for-agent": { actor, createdAt: "2026-10-28T12:00:00Z" },
                },
              },
            }),
          ).toBe(expected);
        }
        expect(
          yield* engine.evaluateBoolean(appSetLabel, environment, {
            item: { state: "OPEN", labelEvents: {} },
          }),
        ).toBe(false);
        yield* engine.checkBoolean(
          Source.make(
            'timestamp(item.labelEvents["ready-for-agent"].createdAt) > timestamp("2026-01-01T00:00:00Z")',
          ),
          environment,
        );
        const badField = yield* Effect.flip(
          engine.checkBoolean(
            Source.make('item.labelEvents["ready-for-agent"].actor.typo == "Bot"'),
            environment,
          ),
        );
        expect(badField.code).toBe("type_error");
      }).pipe(Effect.provide(ConfigParser.layer.pipe(Layer.provideMerge(MarcbachmannCelLayer)))),
  );
}

import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { completionScenarios, openCompletionFixture, recordedValues } from "./completion.ts";
import {
  openFixture,
  openPiFixture,
  piScenarios,
  type Provider,
  recordingModel,
  scenarios,
} from "./fixture.ts";
import { runScenario } from "./scenarios.ts";

export const recordContracts = (provider: Provider): void => {
  for (const scenario of provider === "pi" ? piScenarios : scenarios)
    it.live.skipIf(recordingModel(provider) === undefined)(
      `records ${provider}: ${scenario}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture =
              provider === "pi"
                ? yield* openPiFixture(scenario, "record")
                : yield* openFixture(provider, scenario, "record");
            yield* runScenario(scenario, fixture.request, fixture.controls).pipe(
              Effect.provide(fixture.backend),
              fixture.tape.guard,
            );
            yield* fixture.save;
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      240_000,
    );
  for (const scenario of completionScenarios)
    it.live.skipIf(recordingModel(provider) === undefined)(
      `records ${provider}: ${scenario}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* openCompletionFixture(provider, scenario, "record");
            const completion = yield* fixture.run;
            assert(Result.isSuccess(completion), "the recorded completion returns a value");
            assert.deepStrictEqual(completion.success.value, recordedValues[scenario]);
            yield* fixture.save;
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      240_000,
    );
};

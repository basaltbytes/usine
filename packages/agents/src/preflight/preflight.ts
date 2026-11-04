import type { BrainSpec } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { Effect, Layer } from "effect";
import { Harnesses, harnessesLive, type ProbeTarget } from "../harness/node.ts";

export { CODEX_CLI_VERSION } from "../harness/codex/descriptor.ts";
export { supportedCodexVersions, unsupportedCodexVersion } from "../harness/codex/preflight.ts";

/** Checks one brain through its runtime without a prompt, installation, or login. */
export const preflight = Effect.fn("HarnessPreflight.verify")(function* (
  brain: BrainSpec,
  target: ProbeTarget,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(harnessesLive);
      return yield* Effect.gen(function* () {
        const harnesses = yield* Harnesses;
        const runtime = yield* harnesses.runtime(brain.harness).pipe(
          Effect.mapError((error) =>
            HarnessUnavailableError.make({
              harness: error.harness,
              capability: "binary",
              message: error.message,
            }),
          ),
        );
        return yield* runtime.preflight(brain, target);
      }).pipe(Effect.provideContext(context));
    }),
  ).pipe(Effect.catchTag("HarnessUnavailableError", (unavailable) => Effect.succeed(unavailable)));
});

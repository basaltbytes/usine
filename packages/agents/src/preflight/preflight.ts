import type { BrainSpec } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { Effect } from "effect";
import { Harnesses, type ProbeTarget } from "../harness/node.ts";

export { CODEX_CLI_VERSION } from "../harness/codex/descriptor.ts";
export { supportedCodexVersions, unsupportedCodexVersion } from "../harness/codex/preflight.ts";

/** Checks one brain through its runtime without a prompt, installation, or login. */
export const preflight = Effect.fn("HarnessPreflight.verify")(function* (
  brain: BrainSpec,
  target: ProbeTarget,
) {
  const harnesses = yield* Harnesses;
  return yield* harnesses.runtime(brain.harness).pipe(
    Effect.flatMap((runtime) => runtime.preflight(brain, target)),
    Effect.catchTag("UnknownHarnessError", (error) =>
      Effect.succeed(
        HarnessUnavailableError.make({
          harness: error.harness,
          capability: "binary",
          message: error.message,
        }),
      ),
    ),
  );
});

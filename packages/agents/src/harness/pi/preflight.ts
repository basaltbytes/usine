import { BrainSpec, Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { Effect, Option } from "effect";
import { homedir } from "node:os";
import { checkedPreflight, loginUnavailable, type ProbeTarget } from "../runtime.ts";
import { SessionOperationError } from "../../runtime.ts";
import { PiSdk, usePiStart } from "./sdk.ts";

const check = Effect.fn("PiRuntime.check")(function* (brain: BrainSpec, target: ProbeTarget) {
  const { host, environment } = target;
  yield* Effect.annotateCurrentSpan({
    harness: brain.harness,
    model: brain.model,
    worker: target.worker,
  });
  if (host._tag === "RemoteShell")
    return yield* HarnessUnavailableError.make({
      harness: Harness.make("pi"),
      capability: "binary",
      message: "Pi children run only on local workers",
    });
  // Pi runs from the SDK installed with this process, not from a CLI binary.
  const sdk = yield* PiSdk;
  yield* usePiStart(
    (signal) =>
      sdk.start({
        cwd: homedir(),
        environment: Option.some(environment),
        extensions: [],
        model: brain.model,
        signal,
        thinkingLevel: brain.effort,
      }),
    (cause) =>
      SessionOperationError.make({
        operation: "launch",
        sessionId: Option.none(),
        message: `Can't check Pi authentication for "${brain.model}"`,
        cause,
      }),
    (acquired) =>
      Effect.gen(function* () {
        const result = acquired.result;
        yield* Effect.sync(acquired.dispose);
        if (result._tag !== "Started")
          return yield* loginUnavailable(
            brain,
            `Pi child model "${brain.model}" is unavailable, doesn't support effort ${brain.effort}, or has no supported credential (API key or openai-codex ChatGPT login)`,
          );
      }),
  );
});

/** Captures the SDK used by Pi preflight. */
export const piPreflight = Effect.gen(function* () {
  const context = yield* Effect.context<PiSdk>();
  return checkedPreflight((brain, target) =>
    check(brain, target).pipe(Effect.provideContext(context)),
  );
});

import type { BrainSpec } from "@usine/core/agent/brain";
import { HarnessReady, HarnessUnavailableError } from "@usine/core/agent/capability";
import { Effect, Option, Schema } from "effect";
import { homedir } from "node:os";
import { WorkingDirectory } from "../runtime.ts";
import { CodexAppServer, codexAppServerLive } from "../pi/codex/app-server.ts";
import { initializeCodex, verifyCodexAccount } from "../pi/codex/account.ts";
import { PiSdk, piSdkLive, usePiStart } from "../pi/sdk.ts";
import { probeCommand } from "./command.ts";

/** Codex CLI version verified by the pinned app-server protocol conformance gate. */
export const CODEX_CLI_VERSION = "0.144.0";

const ClaudeAuthentication = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.String,
  apiProvider: Schema.String,
});

/** Verifies a rostered brain through supplied process and SDK services; starts no prompt. */
export const verifyHarness = Effect.fn("HarnessPreflight.verify")(
  function* (brain: BrainSpec) {
    yield* Effect.annotateCurrentSpan({ harness: brain.harness, model: brain.model });
    const loginError = (message: string) =>
      new HarnessUnavailableError({
        harness: brain.harness,
        capability: "login",
        message,
      });
    switch (brain.harness) {
      case "codex": {
        const version = yield* probeCommand("codex", "binary", "codex", ["--version"]);
        if (version !== `codex-cli ${CODEX_CLI_VERSION}`)
          return yield* new HarnessUnavailableError({
            harness: "codex",
            capability: "version",
            message: `Worker has ${/^codex-cli [0-9]+\.[0-9]+\.[0-9]+$/u.test(version) ? version : "an unrecognized Codex version"}; expected codex-cli ${CODEX_CLI_VERSION}`,
          });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* CodexAppServer;
            const connection = yield* server.open({
              cwd: WorkingDirectory.make(homedir()),
              sessionId: Option.none(),
            });
            yield* initializeCodex(connection);
            yield* verifyCodexAccount(connection, brain.model);
          }),
        ).pipe(
          Effect.mapError(() =>
            loginError("Codex requires a usable ChatGPT login; run codex login on the Worker"),
          ),
        );
        break;
      }
      case "claude": {
        yield* probeCommand("claude", "binary", "claude", ["--version"]);
        const response = yield* probeCommand("claude", "login", "claude", [
          "auth",
          "status",
          "--json",
        ]);
        const auth = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeAuthentication))(
          response,
        ).pipe(Effect.mapError(() => loginError("Claude returned an unrecognized login status")));
        if (!auth.loggedIn || auth.authMethod !== "claude.ai" || auth.apiProvider !== "firstParty")
          return yield* loginError(
            "Claude requires a subscription login; run claude auth login on the Worker",
          );
        break;
      }
      case "pi": {
        // Pi is the SDK installed with this run host, not a separate CLI binary.
        const sdk = yield* PiSdk;
        yield* usePiStart(
          (signal) =>
            sdk.start({
              cwd: homedir(),
              extensions: [],
              model: Option.some(brain.model),
              signal,
              thinkingLevel: brain.effort,
              toolMode: "repository",
            }),
          () => loginError(`Pi could not check authentication for ${brain.model}`),
          (acquired) =>
            Effect.gen(function* () {
              const result = acquired.result;
              yield* Effect.sync(acquired.dispose);
              if (result._tag !== "Started" || result.pool !== "apiKeys")
                return yield* loginError(
                  `Pi child model ${brain.model} requires an available model, supported effort, and API-key authentication`,
                );
            }),
        );
        break;
      }
    }
    yield* Effect.logInfo("Worker harness verified", {
      harness: brain.harness,
      model: brain.model,
    });
    return new HarnessReady({ harness: brain.harness });
  },
  (effect, brain) =>
    effect.pipe(
      Effect.timeout("60 seconds"),
      Effect.catchTag(
        "TimeoutError",
        () =>
          new HarnessUnavailableError({
            harness: brain.harness,
            capability: "login",
            message: `${brain.harness} readiness check timed out`,
          }),
      ),
      Effect.tapError((error) =>
        Effect.logError("Worker harness preflight failed", {
          harness: error.harness,
          capability: error.capability,
          message: error.message,
        }),
      ),
    ),
);

/** Checks only the requested brain using the worker user's configuration, without running a prompt or logging in. */
export const preflight = (brain: BrainSpec) =>
  verifyHarness(brain).pipe(Effect.provide(codexAppServerLive), Effect.provide(piSdkLive));

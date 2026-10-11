import type { BrainSpec } from "@usine/core/agent/brain";
import {
  type HarnessCapability,
  HarnessReady,
  HarnessUnavailableError,
} from "@usine/core/agent/capability";
import { Effect, Option, Schema } from "effect";
import { homedir } from "node:os";
import type { ChildHost } from "../child-host/child-host.ts";
import { SessionOperationError, WorkingDirectory } from "../runtime.ts";
import { CodexAppServer, codexAppServerLive } from "../pi/codex/app-server.ts";
import { initializeCodex, verifyCodexAccount } from "../pi/codex/account.ts";
import { PiSdk, piSdkLive, usePiStart } from "../pi/sdk.ts";
import { probeCommand } from "./command.ts";

/** Baseline Codex CLI version used by the pinned app-server protocol conformance gate. */
export const CODEX_CLI_VERSION = "0.144.0";

// Additional exact builds require generated-type review and the live contracts.
const supportedCodexVersions = [CODEX_CLI_VERSION, "0.153.4"];

const ClaudeAuthentication = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.String,
  apiProvider: Schema.String,
});

/**
 * Verifies a rostered brain where `host` runs children, through supplied
 * process and SDK services; starts no prompt. Every check process sees
 * `environment` as a child would: as its complete environment on this
 * machine, or exported on top of a remote host's own (ADR 0011). Pi children
 * run their tools in this process, so a remote host cannot run them.
 */
export const verifyHarness = Effect.fn("HarnessPreflight.verify")(
  function* (brain: BrainSpec, host: ChildHost, environment: Readonly<Record<string, string>>) {
    yield* Effect.annotateCurrentSpan({
      harness: brain.harness,
      model: brain.model,
      host: host._tag,
    });
    const loginError = (message: string) =>
      new HarnessUnavailableError({
        harness: brain.harness,
        capability: "login",
        message,
      });
    const probe = (capability: HarnessCapability, command: string, args: ReadonlyArray<string>) =>
      probeCommand(host, environment, brain.harness, capability, command, args);
    switch (brain.harness) {
      case "codex": {
        const version = yield* probe("binary", "codex", ["--version"]);
        if (!supportedCodexVersions.some((supported) => version === `codex-cli ${supported}`))
          return yield* new HarnessUnavailableError({
            harness: "codex",
            capability: "version",
            message: `Worker has ${/^codex-cli [0-9]+\.[0-9]+\.[0-9]+$/u.test(version) ? version : "an unrecognized Codex version"}; supported Codex CLI versions: ${supportedCodexVersions.join(", ")}`,
          });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* CodexAppServer;
            const connection = yield* server.open({
              cwd: WorkingDirectory.make(homedir()),
              sessionId: Option.none(),
              environment,
              host,
            });
            yield* initializeCodex(connection);
            yield* verifyCodexAccount(connection, brain.model);
          }),
        ).pipe(Effect.catchTag("PoolUnavailableError", (error) => loginError(error.message)));
        break;
      }
      case "claude": {
        yield* probe("binary", "claude", ["--version"]);
        const response = yield* probe("login", "claude", ["auth", "status", "--json"]);
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
        if (host._tag === "RemoteShell")
          return yield* new HarnessUnavailableError({
            harness: "pi",
            capability: "binary",
            message: "Pi children run only on local Workers",
          });
        // Pi is the SDK installed with this process, not a separate CLI binary.
        const sdk = yield* PiSdk;
        yield* usePiStart(
          (signal) =>
            sdk.start({
              cwd: homedir(),
              environment: Option.none(),
              extensions: [],
              model: Option.some(brain.model),
              signal,
              thinkingLevel: brain.effort,
              toolMode: "repository",
            }),
          (cause) =>
            new SessionOperationError({
              operation: "launch",
              sessionId: Option.none(),
              message: `Pi could not check authentication for ${brain.model}`,
              cause,
            }),
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
      host: host._tag,
    });
    return new HarnessReady({ harness: brain.harness });
  },
  (effect, brain) =>
    effect.pipe(
      Effect.timeout("60 seconds"),
      Effect.catchTag(
        "TimeoutError",
        (cause) =>
          new SessionOperationError({
            operation: "launch",
            sessionId: Option.none(),
            message: `${brain.harness} readiness check timed out`,
            cause,
          }),
      ),
      Effect.tapError((error) =>
        Effect.logError("Worker harness preflight failed", {
          harness: brain.harness,
          model: brain.model,
          errorTag: error._tag,
          message: error.message,
        }),
      ),
    ),
);

/** Checks only the requested brain where `host` runs children, with `environment` and the worker user's configuration, without running a prompt or logging in. */
export const preflight = (
  brain: BrainSpec,
  host: ChildHost,
  environment: Readonly<Record<string, string>>,
) =>
  verifyHarness(brain, host, environment).pipe(
    Effect.provide(codexAppServerLive),
    Effect.provide(piSdkLive),
  );

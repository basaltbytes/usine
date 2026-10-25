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
import { probeCommand, probeFailed, probeOutput } from "./command.ts";

/** The Codex CLI version of the pinned app-server protocol package used by the conformance check. */
export const CODEX_CLI_VERSION = "0.159.2";

/**
 * The Codex CLI versions that preflight accepts, the conformance baseline first. Adding a version
 * needs a review of its generated protocol types and a run of the live contracts.
 */
export const supportedCodexVersions: ReadonlyArray<string> = [
  CODEX_CLI_VERSION,
  "0.159.0",
  "0.159.1",
  "0.159.3",
  "0.153.4",
];

const ClaudeAuthentication = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.String,
  apiProvider: Schema.String,
});
const decodeClaudeAuthentication = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeAuthentication),
);
const CLAUDE_AUTH_STATUS = ["auth", "status", "--json"];

/**
 * Checks `brain` on `host` without starting a prompt; each check process gets `environment` as its
 * complete local environment, or on top of the remote host's environment (ADR 0011). Fails with
 * `HarnessUnavailableError` for Pi on a remote host.
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
            message: `The worker has ${/^codex-cli [0-9]+\.[0-9]+\.[0-9]+$/u.test(version) ? version : "an unrecognized Codex version"}. Install a supported Codex CLI version: ${supportedCodexVersions.join(", ")}.`,
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
        const status = yield* probeOutput(
          host,
          environment,
          "claude",
          "login",
          "claude",
          CLAUDE_AUTH_STATUS,
        );
        // Claude prints the same status and exits 1 when not logged in.
        const auth =
          status.exitCode === 0 || status.exitCode === 1
            ? decodeClaudeAuthentication(status.stdout)
            : Option.none();
        if (Option.isNone(auth))
          return yield* status.exitCode === 0
            ? loginError("Claude returned an unrecognized login status")
            : probeFailed("claude", "login", "claude", CLAUDE_AUTH_STATUS);
        const { loggedIn, authMethod, apiProvider } = auth.value;
        if (
          status.exitCode !== 0 ||
          !loggedIn ||
          authMethod !== "claude.ai" ||
          apiProvider !== "firstParty"
        )
          return yield* loginError(
            "Claude Code needs a subscription login. Run claude auth login on the worker.",
          );
        break;
      }
      case "pi": {
        if (host._tag === "RemoteShell")
          return yield* new HarnessUnavailableError({
            harness: "pi",
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
            new SessionOperationError({
              operation: "launch",
              sessionId: Option.none(),
              message: `Can't check Pi authentication for "${brain.model}"`,
              cause,
            }),
          (acquired) =>
            Effect.gen(function* () {
              const result = acquired.result;
              yield* Effect.sync(acquired.dispose);
              if (result._tag !== "Started" || result.pool !== "apiKeys")
                return yield* loginError(
                  `Pi child model "${brain.model}" is unavailable, doesn't support effort ${brain.effort}, or doesn't use an API key`,
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

/** Checks only `brain` on `host`, with `environment` and the Worker user's configuration; does not run a prompt or log in. */
export const preflight = (
  brain: BrainSpec,
  host: ChildHost,
  environment: Readonly<Record<string, string>>,
) =>
  verifyHarness(brain, host, environment).pipe(
    Effect.provide(codexAppServerLive),
    Effect.provide(piSdkLive),
  );

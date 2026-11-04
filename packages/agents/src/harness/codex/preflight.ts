import { BrainSpec, Harness } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { Effect, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { checkedPreflight, loginUnavailable, type ProbeTarget } from "../runtime.ts";
import { probeCommand } from "../../preflight/command.ts";
import { WorkingDirectory } from "../../runtime.ts";
import { CodexAppServer, codexConfigArgs } from "./app-server.ts";
import { initializeCodex, verifyCodexAccount } from "./account.ts";
import { codex } from "./descriptor.ts";
/** The accepted Codex CLI versions, with the protocol baseline first. */
export const supportedCodexVersions = codex.worker.versions;

/** Returns the error for `codex --version` output that names no supported Codex CLI version. */
export const unsupportedCodexVersion = (version: string): Option.Option<HarnessUnavailableError> =>
  supportedCodexVersions.some((supported) => version === `codex-cli ${supported}`)
    ? Option.none()
    : Option.some(
        HarnessUnavailableError.make({
          harness: Harness.make("codex"),
          capability: "version",
          message: `The worker has ${/^codex-cli [0-9]+\.[0-9]+\.[0-9]+$/u.test(version) ? version : "an unrecognized Codex version"}. Install a supported Codex CLI version: ${supportedCodexVersions.join(", ")}.`,
        }),
      );

const check = Effect.fn("CodexRuntime.check")(function* (brain: BrainSpec, target: ProbeTarget) {
  const { host, environment } = target;
  yield* Effect.annotateCurrentSpan({
    harness: brain.harness,
    model: brain.model,
    worker: target.worker,
  });
  const probe = (capability: "binary", command: string, args: ReadonlyArray<string>) =>
    probeCommand(host, environment, brain.harness, capability, command, args);
  if (host._tag === "RemoteShell") yield* probe("binary", "node", ["--version"]);
  const version = yield* probe("binary", "codex", [...codexConfigArgs, "--version"]);
  const unsupported = unsupportedCodexVersion(version);
  if (Option.isSome(unsupported)) return yield* unsupported.value;
  if (target.credential !== "host-login") {
    yield* Effect.logInfo("Harness uses an external credential; skipped the host login check", {
      harness: brain.harness,
      credential: target.credential,
      worker: target.worker,
    });
    return;
  }
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
  ).pipe(
    Effect.catchTag("PoolUnavailableError", (error) => loginUnavailable(brain, error.message)),
  );
});

/** Captures the process and account services used by Codex preflight. */
export const codexPreflight = Effect.gen(function* () {
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | CodexAppServer>();
  return checkedPreflight((brain, target) =>
    check(brain, target).pipe(Effect.provideContext(context)),
  );
});

import { BrainSpec } from "@usine/core/agent/brain";
import { Effect, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { checkedPreflight, loginUnavailable, type ProbeTarget } from "../runtime.ts";
import { isRemoteHost } from "../../child-host/child-host.ts";
import { probeBinary, probeFailed, probeOutput } from "../../preflight/command.ts";
import { claude } from "./descriptor.ts";
import { HostLoginLock } from "../../runtime.ts";
const ClaudeAuthentication = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.String,
  apiProvider: Schema.String,
});
const decodeClaudeAuthentication = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeAuthentication),
);
const CLAUDE_AUTH_STATUS = ["auth", "status", "--json"];

const check = Effect.fn("ClaudeRuntime.check")(function* (brain: BrainSpec, target: ProbeTarget) {
  const { host, environment } = target;
  yield* Effect.annotateCurrentSpan({
    harness: brain.harness,
    model: brain.model,
    worker: target.worker,
  });
  if (isRemoteHost(host)) yield* probeBinary(claude, target, "node", ["--version"]);
  yield* probeBinary(claude, target, "claude", ["--version"]);
  if (target.credential !== "host-login") {
    yield* Effect.logInfo("Harness uses an external credential; skipped the host login check", {
      harness: brain.harness,
      credential: target.credential,
      worker: target.worker,
    });
    return;
  }
  const status = yield* probeOutput(
    host,
    environment,
    brain.harness,
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
      ? loginUnavailable(brain, "Claude returned an unrecognized login status")
      : probeFailed(brain.harness, "login", "claude", CLAUDE_AUTH_STATUS);
  const { loggedIn, authMethod, apiProvider } = auth.value;
  if (
    status.exitCode !== 0 ||
    !loggedIn ||
    !["claude.ai", "oauth_token", "api_key"].includes(authMethod) ||
    apiProvider !== "firstParty"
  )
    return yield* loginUnavailable(
      brain,
      "Claude Code needs a subscription login or API key. Run claude auth login on the worker.",
    );
});

/** Serializes host-login checks with child startup; lock waits precede the probe deadline. */
export const claudePreflight = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const logins = yield* HostLoginLock;
  const preflight = checkedPreflight((brain, target) =>
    check(brain, target).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
  );
  return Effect.fn("ClaudeRuntime.preflight")(function* (brain: BrainSpec, target: ProbeTarget) {
    yield* Effect.annotateCurrentSpan({
      harness: brain.harness,
      model: brain.model,
      worker: target.worker,
    });
    return yield* target.credential === "host-login"
      ? logins.withLock(brain.harness, target.worker, target.machine)(preflight(brain, target))
      : preflight(brain, target);
  });
});

import type { BrainSpec } from "@usine/core/agent/brain";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { Effect, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { isRemoteHost } from "../../child-host/child-host.ts";
import { probeBinary } from "../../preflight/command.ts";
import { checkedPreflight, loginUnavailable, type ProbeTarget } from "../runtime.ts";
import { openCodeApi } from "./api.ts";
import { openCodeDirectories, serveConfig, serveVariables } from "./config.ts";
import { OPENCODE_VERSION, opencode } from "./descriptor.ts";
import { checkModel, modelChoice } from "./model.ts";
import { OpenCodeServer } from "./server.ts";

/**
 * Returns a script that runs `opencode` with the script's arguments in a temporary directory, which
 * it removes when OpenCode exits, and with the assignments that `variables` returns for `$dir`, the
 * directory's path. The shell expands each value. The probes use no folder of the home directory,
 * which a container's volume mounts can leave owned by root.
 */
const temporaryOpenCode = (variables: (dir: string) => Readonly<Record<string, string>>) => {
  const assignments = Object.entries(variables("$dir"))
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  return String.raw`
dir=$(mktemp -d) || exit 1
cd "$dir" || exit 1
${assignments} opencode "$@"
status=$?
rm -rf "$dir"
exit "$status"
`.trim();
};

/** Runs `opencode` with the script's arguments, such as `--version`. */
const VERSION_SCRIPT = temporaryOpenCode(openCodeDirectories);

/** Starts `opencode serve` with `$1` as its configuration. The remaining arguments are `serve`'s. */
const PROBE_SCRIPT = String.raw`
config=$1
shift
${temporaryOpenCode((dir) => serveVariables(dir, "$config"))}
`.trim();

/** Returns the error for `opencode --version` output that names another release than the pin. */
const unsupportedOpenCodeVersion = (version: string): Option.Option<HarnessUnavailableError> =>
  version.trim() === `opencode v${OPENCODE_VERSION}`
    ? Option.none()
    : Option.some(
        HarnessUnavailableError.make({
          harness: opencode.id,
          capability: "version",
          message: `The worker has ${/^opencode v\d+\.\d+\.\d+$/u.test(version.trim()) ? version.trim() : "an unrecognized OpenCode version"}. Install @opencode/cli ${OPENCODE_VERSION}.`,
        }),
      );

const check = Effect.fn("OpenCodeRuntime.check")(function* (brain: BrainSpec, target: ProbeTarget) {
  yield* Effect.annotateCurrentSpan({
    harness: brain.harness,
    model: brain.model,
    worker: target.worker,
    credential: target.credential,
  });
  if (isRemoteHost(target.host)) yield* probeBinary(opencode, target, "node", ["--version"]);
  const version = yield* probeBinary(opencode, target, "opencode", ["--version"], {
    command: "sh",
    args: ["-c", VERSION_SCRIPT, "sh", "--version"],
  });
  const unsupported = unsupportedOpenCodeVersion(version);
  if (Option.isSome(unsupported)) return yield* unsupported.value;
  const server = yield* OpenCodeServer;
  const choice = yield* modelChoice(brain).pipe(
    Effect.catchTag("UnknownModelError", (error) => loginUnavailable(brain, error.message)),
  );
  const config = yield* serveConfig({
    choice,
    route: target.credential,
    cwd: "/",
    baseUrl: Option.none(),
  });
  // The probe has no session, so a remote host gets no environment; the script sets OpenCode's.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* server.open({
        host: target.host,
        cwd: "/",
        environment: target.environment,
        sessionId: Option.none(),
        command: { command: "sh", args: ["-c", PROBE_SCRIPT, "sh", config] },
      });
      yield* checkModel(openCodeApi(connection, Option.none()), brain, choice, Option.none());
    }),
  ).pipe(
    Effect.catchTags({
      UnknownModelError: (error) => loginUnavailable(brain, error.message),
      UnsupportedEffortError: (error) => loginUnavailable(brain, error.message),
    }),
  );
});

/** Captures the process services used by OpenCode preflight. */
export const openCodePreflight = Effect.gen(function* () {
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | OpenCodeServer>();
  return checkedPreflight((brain, target) =>
    check(brain, target).pipe(Effect.provideContext(context)),
  );
});

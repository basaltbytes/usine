import { Effect, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { HarnessUnavailableError } from "@usine/core/agent/capability";
import { probeBinary } from "../../preflight/command.ts";
import { WorkingDirectory } from "../../runtime.ts";
import { checkedPreflight, loginUnavailable } from "../runtime.ts";
import { opencode, OPENCODE_VERSION } from "./descriptor.ts";
import { modelRoute } from "./model.ts";
import { OpenCodeServer } from "./server.ts";

export const openCodePreflight = Effect.gen(function* () {
  const server = yield* OpenCodeServer;
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  return checkedPreflight((brain, target) =>
    Effect.gen(function* () {
      const version = yield* probeBinary(opencode, target, "opencode", ["--version"]);
      if (!opencode.worker.versions.includes(version))
        return yield* HarnessUnavailableError.make({
          harness: opencode.id,
          capability: "version",
          message: `Install @opencode/cli@${OPENCODE_VERSION} on the worker`,
        });
      if (target.credential !== "host-login") {
        yield* Effect.logInfo(
          "OpenCode uses an external credential; skipped host login verification",
          { worker: target.worker, credential: target.credential },
        );
        return;
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = {
            cwd: WorkingDirectory.make("/"),
            sessionId: Option.none(),
            environment: target.environment,
            host: target.host,
          };
          const connection = yield* server.open(client);
          yield* modelRoute(brain, client, connection, Option.none()).pipe(
            Effect.catchTags({
              UnknownModelError: (error) => loginUnavailable(brain, error.message),
              PoolUnavailableError: (error) => loginUnavailable(brain, error.message),
              UnsupportedEffortError: (error) => loginUnavailable(brain, error.message),
            }),
          );
          yield* connection.close;
        }),
      );
    }).pipe(Effect.provideContext(context)),
  );
});

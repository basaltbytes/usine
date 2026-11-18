import {
  SupervisorSandbox,
  type SupervisorSandboxService,
  SupervisorUnavailable,
} from "@usine/agents/supervisor";
import type { InstanceDirectory, InstanceId } from "@usine/core/instance";
import { SupervisorLimits, WorkerName } from "@usine/core/worker";
import { ATTEMPT_IMAGE } from "@usine/executor/ssh";
import {
  containerSandboxLayer,
  fileHomesLayer,
  makeSupervisorSources,
  type SupervisorSources,
} from "@usine/executor/supervisor";
import { GitHubApp } from "@usine/github/github-app";
import type { RepositoryName } from "@usine/core/repository";
import { Context, Duration, Effect, Layer, Option } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";
import { instanceModelRoute } from "./parent-models.ts";

/**
 * Waits for `sandbox`'s startup check, then logs a warning, with the reason, when the instance
 * configures a supervisor that `sandbox` can't run sessions for. The orchestrator starts either
 * way.
 */
export const reportSupervisorAvailability = Effect.fn("Supervisor.reportAvailability")(function* (
  configured: boolean,
  sandbox: SupervisorSandboxService,
) {
  if (!configured) return;
  const unavailable = yield* sandbox.checked;
  if (Option.isNone(unavailable)) return;
  yield* Effect.logWarning("The configured supervisor is unavailable on this orchestrator", {
    reason: unavailable.value.message,
  });
});

/**
 * The orchestrator's supervisor sandbox: a container per turn on this host, with the attempt
 * image, whose model requests go through the instance's gateway route, and the conversations'
 * saved homes under `.usine/supervisor/homes`. Builds without a container runtime or a gateway,
 * and then logs the reason when the instance configures a supervisor.
 */
export const supervisorSandboxLayer = (
  instanceDirectory: InstanceDirectory,
  instanceId: InstanceId,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const startup = yield* (yield* CurrentInstance).get;
      const route = yield* instanceModelRoute(startup, WorkerName.make(`supervisor-${instanceId}`));
      const root = `${instanceDirectory}/.usine/supervisor`;
      return containerSandboxLayer({
        root,
        image: ATTEMPT_IMAGE,
        imagePullTimeout: startup.config.settings.supervisorImagePullTimeoutMinutes.pipe(
          Option.map(Duration.minutes),
          Option.getOrUndefined,
        ),
        limits: Option.getOrElse(startup.config.settings.supervisorLimits, () =>
          SupervisorLimits.make({}),
        ),
        runtime: Option.none(),
        route,
      }).pipe(
        Layer.provide(fileHomesLayer(`${root}/homes`)),
        Layer.tap((context) =>
          reportSupervisorAvailability(
            Option.isSome(startup.config.settings.supervisor),
            Context.get(context, SupervisorSandbox),
          ).pipe(Effect.forkScoped({ startImmediately: true })),
        ),
      );
    }),
  );

/** The source that supervisor turns read: each repository's default-branch head. */
export class SupervisorSourceTrees extends Context.Service<
  SupervisorSourceTrees,
  SupervisorSources
>()("@usine/orchestrator/supervisor-sandbox/SupervisorSourceTrees") {}

/**
 * The supervisor's source under the instance's `.usine/supervisor/sources`, fetched from GitHub
 * with a read-only token for each repository that the GitHub App mints. The token stays on the
 * orchestrator.
 */
export const supervisorSourcesLayer = (instanceDirectory: InstanceDirectory) =>
  Layer.effect(
    SupervisorSourceTrees,
    Effect.gen(function* () {
      const app = yield* GitHubApp;
      const unavailable = (repository: RepositoryName) => (error: { readonly message: string }) =>
        SupervisorUnavailable.make({
          message: `Can't get a token to read ${repository}: ${error.message}`,
        });
      return yield* makeSupervisorSources(`${instanceDirectory}/.usine/supervisor/sources`, {
        url: (repository) => `https://github.com/${repository}.git`,
        token: Effect.fn("SupervisorSources.token")(function* (repository) {
          const [access] = yield* app
            .projectAccess([repository])
            .pipe(Effect.mapError(unavailable(repository)));
          if (access?._tag !== "CoveredProject")
            return yield* SupervisorUnavailable.make({
              message: `The GitHub App installation can't read ${repository}`,
            });
          const token = yield* app
            .workerToken(access, "read")
            .pipe(Effect.mapError(unavailable(repository)));
          return Option.some(token.value);
        }),
      });
    }),
  );

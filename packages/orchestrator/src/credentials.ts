import type { RepositoryName } from "@usine/core/repository";
import {
  CredentialProvider,
  CredentialUnavailableError,
  type CredentialUnavailableReason,
  WorkerCredential,
} from "@usine/executor";
import {
  CoveredProject,
  GitHubApp,
  type GitHubAppError,
  isRefusal,
} from "@usine/github/github-app";
import { Effect, Layer, Option, SynchronizedRef } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";

const reasonOf = (cause: GitHubAppError): CredentialUnavailableReason =>
  isRefusal(cause) ? "refused" : "unreachable";

/**
 * Mints renewable single-repository GitHub App tokens at each Attempt's Loop permission level (ADR
 * 0011). Fails with a `refused` credential error if GitHub refuses, or `unreachable` on an outage
 * or rate limit.
 */
export const gitHubCredentialLayer: Layer.Layer<
  CredentialProvider,
  never,
  CurrentInstance | GitHubApp
> = Layer.effect(
  CredentialProvider,
  Effect.gen(function* () {
    const app = yield* GitHubApp;
    const instances = yield* CurrentInstance;
    const projectsRef = yield* SynchronizedRef.make(
      Option.none<ReadonlyMap<RepositoryName, CoveredProject>>(),
    );

    const discover = (repository: RepositoryName) =>
      instances.get.pipe(
        Effect.flatMap(({ config }) => app.projectAccess(config.repos.map(({ name }) => name))),
        Effect.map(
          (access) =>
            new Map(
              access
                .filter((project): project is CoveredProject => project._tag === "CoveredProject")
                .map((project) => [project.repository, project]),
            ),
        ),
        Effect.mapError(
          (cause) =>
            new CredentialUnavailableError({
              repository,
              reason: reasonOf(cause),
              message: `Could not discover GitHub App repository access: ${cause.message}`,
              cause,
            }),
        ),
      );

    /** Refreshes the cached project map once on a miss before returning "not covered". */
    const projectFor = Effect.fn("GitHubCredentialProvider.projectFor")(function* (
      repository: RepositoryName,
    ) {
      const project = yield* SynchronizedRef.modifyEffect(projectsRef, (current) =>
        Effect.gen(function* () {
          if (Option.isSome(current)) {
            const found = current.value.get(repository);
            if (found !== undefined) {
              const kept: [Option.Option<CoveredProject>, typeof current] = [
                Option.some(found),
                current,
              ];
              return kept;
            }
          }
          const refreshed = yield* discover(repository);
          const refreshedResult: [
            Option.Option<CoveredProject>,
            Option.Option<ReadonlyMap<RepositoryName, CoveredProject>>,
          ] = [Option.fromNullishOr(refreshed.get(repository)), Option.some(refreshed)];
          return refreshedResult;
        }),
      );
      if (Option.isNone(project)) {
        return yield* new CredentialUnavailableError({
          repository,
          reason: "refused",
          message: `GitHub App installation does not cover ${repository}`,
          cause: new Error("no project access after refresh"),
        });
      }
      return project.value;
    });

    return CredentialProvider.of({
      issue: Effect.fn("GitHubCredentialProvider.issue")(
        function* (repository, attemptId, permissions) {
          yield* Effect.annotateCurrentSpan({ repository, attemptId, permissions });
          const project = yield* projectFor(repository);
          const token = yield* app.workerToken(project, permissions).pipe(
            Effect.mapError(
              (cause) =>
                new CredentialUnavailableError({
                  repository,
                  reason: reasonOf(cause),
                  message: `Could not mint a worker token for ${repository}: ${cause.message}`,
                  cause,
                }),
            ),
          );
          yield* Effect.logInfo("Minted a single-repository worker token", {
            repository,
            attemptId,
            permissions,
          });
          return new WorkerCredential({ value: token.value, expiresAt: token.expiresAt });
        },
      ),
    });
  }),
);

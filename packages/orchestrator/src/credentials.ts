import type { RepositoryName } from "@usine/core/repository";
import { CredentialProvider, CredentialUnavailableError, WorkerCredential } from "@usine/executor";
import { GitHubApp, CoveredProject } from "@usine/github/github-app";
import { Effect, Layer, Option, SynchronizedRef } from "effect";
import { CurrentInstance } from "./current-instance/current-instance.ts";

/**
 * Mints renewable single-repository GitHub App tokens for each Attempt, at
 * the permission level of the Attempt's Loop (ADR 0011). Project
 * access is discovered on the first mint and cached, so a GitHub outage cannot
 * block startup. A repository added to the installation, or to the current
 * instance's registry by a reload, is found by the refresh that follows a miss.
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
              message: "Could not discover GitHub App repository access",
              cause,
            }),
        ),
      );

    /** Refreshes the cached project map once on a miss before answering "not covered". */
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
                  message: `Could not mint a worker token for ${repository}`,
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

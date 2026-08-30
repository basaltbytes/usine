import type { UsineConfig } from "@usine/config";
import { Repository } from "@usine/core";
import { CredentialProvider, CredentialUnavailableError } from "@usine/executor";
import { CoveredProject, GitHubApp } from "@usine/github";
import { Effect, Layer } from "effect";

/** Mints one fresh, single-repository GitHub App token per Attempt. */
export const gitHubCredentialLayer = (
  config: UsineConfig,
): Layer.Layer<CredentialProvider, CredentialUnavailableError, GitHubApp> =>
  Layer.effect(
    CredentialProvider,
    Effect.gen(function* () {
      const app = yield* GitHubApp;
      const access = yield* app.projectAccess(config.repos.map(({ name }) => name)).pipe(
        Effect.mapError(
          (cause) =>
            new CredentialUnavailableError({
              repository: config.repos[0]?.name ?? Repository.Name.make("unknown/unknown"),
              message: "Could not discover GitHub App repository access",
              cause,
            }),
        ),
      );
      const projects = new Map(
        access
          .filter((project): project is CoveredProject => project._tag === "CoveredProject")
          .map((project) => [project.repository, project]),
      );
      return CredentialProvider.of({
        issue: Effect.fn("GitHubCredentialProvider.issue")(function* (repository, attemptId) {
          const project = projects.get(repository);
          if (project === undefined) {
            return yield* new CredentialUnavailableError({
              repository,
              message: `GitHub App installation does not cover ${repository}`,
              cause: new Error(`No project access for Attempt ${attemptId}`),
            });
          }
          return yield* app.workerToken(project).pipe(
            Effect.map((token) => token.value),
            Effect.mapError(
              (cause) =>
                new CredentialUnavailableError({
                  repository,
                  message: `Could not mint a worker token for ${repository}`,
                  cause,
                }),
            ),
          );
        }),
      });
    }),
  );

import { Repository } from "@usine/core";
import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { AppJwtSigner } from "./jwt.ts";
import {
  AccountLogin,
  AppPermissionError,
  CoveredProject,
  GitHubApiError,
  type GitHubAppError,
  GitHubCredentials,
  type GitHubOperation,
  Installation,
  InstallationDiscoveryError,
  InstallationId,
  InstallationToken,
  InstallationWide,
  InvalidGitHubResponseError,
  type ProjectAccess,
  REQUIRED_REPOSITORY_PERMISSIONS,
  RepositoryId,
  SingleRepository,
  type TokenScope,
  deriveProjectAccess,
} from "./model.ts";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const TOKEN_MAX_LIFETIME_MS = 60 * 60 * 1_000;

interface MintRequest {
  readonly installationId: InstallationId;
  readonly operation: GitHubOperation;
  readonly body: Schema.Json;
  readonly scope: TokenScope;
}

const InstallationResponse = Schema.Struct({
  id: InstallationId,
  account: Schema.Struct({ login: AccountLogin }),
  permissions: Schema.Record(Schema.String, Schema.String),
  suspendedAt: Schema.NullOr(Schema.String),
}).pipe(Schema.encodeKeys({ suspendedAt: "suspended_at" }));

const InstallationsResponse = Schema.Array(InstallationResponse);

const RepositoryResponse = Schema.Struct({
  id: RepositoryId,
  name: Repository.Name,
}).pipe(Schema.encodeKeys({ name: "full_name" }));

const RepositoriesResponse = Schema.Struct({
  totalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  repositories: Schema.Array(RepositoryResponse),
}).pipe(Schema.encodeKeys({ totalCount: "total_count" }));

const TokenResponse = Schema.Struct({
  token: Schema.NonEmptyString,
  expiresAt: Schema.DateTimeUtcFromString,
  repositories: Schema.OptionFromOptionalKey(Schema.Array(RepositoryResponse)),
}).pipe(Schema.encodeKeys({ expiresAt: "expires_at" }));

const requiredLevelIsPresent = (actual: string | undefined, required: "read" | "write") =>
  actual === required || (required === "read" && actual === "write");

const missingPermissions = (permissions: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(REQUIRED_REPOSITORY_PERMISSIONS).flatMap(([permission, required]) =>
    requiredLevelIsPresent(permissions[permission], required) ? [] : [`${permission}:${required}`],
  );

const requestHeaders = (credential: Redacted.Redacted<string>) =>
  HttpClientRequest.setHeaders({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${Redacted.value(credential)}`,
    "user-agent": "usine",
    "x-github-api-version": API_VERSION,
  });

const apiFailure = (operation: GitHubOperation, status: Option.Option<number>, message: string) =>
  new GitHubApiError({ operation, status, message });

const adapterDefect = (operation: GitHubOperation) =>
  apiFailure(
    operation,
    Option.none(),
    "The GitHub adapter failed outside its typed failure channel",
  );

/**
 * Whole GitHub identity for one usine instance. The transport is supplied as
 * an Effect HttpClient, so the root entry remains platform-free.
 */
export class GitHubApp extends Context.Service<
  GitHubApp,
  {
    readonly installation: () => Effect.Effect<Installation, GitHubAppError>;
    readonly installationToken: () => Effect.Effect<InstallationToken, GitHubAppError>;
    readonly projectAccess: (
      registry: ReadonlyArray<Repository.Name>,
    ) => Effect.Effect<ReadonlyArray<ProjectAccess>, GitHubAppError>;
    readonly workerToken: (
      project: CoveredProject,
    ) => Effect.Effect<InstallationToken, GitHubAppError>;
  }
>()("@usine/github/GitHubApp") {
  static readonly layer = Layer.effect(
    GitHubApp,
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials;
      const jwtSigner = yield* AppJwtSigner;
      const http = yield* HttpClient.HttpClient;

      const execute = (
        operation: GitHubOperation,
        request: HttpClientRequest.HttpClientRequest,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, GitHubApiError> =>
        http.execute(request).pipe(
          Effect.mapError(() =>
            apiFailure(operation, Option.none(), "The request to GitHub could not be sent"),
          ),
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed(response)
              : apiFailure(
                  operation,
                  Option.some(response.status),
                  `GitHub rejected the request with status ${response.status}`,
                ),
          ),
        );

      const invalidResponse = (operation: GitHubOperation) =>
        new InvalidGitHubResponseError({
          operation,
          message: "GitHub returned a response that does not match its API contract",
        });

      const discoverInstallation = Effect.fn("GitHubApp.discoverInstallation")(function* () {
        const jwt = yield* jwtSigner.sign(credentials);
        const request = HttpClientRequest.get(`${API_ROOT}/app/installations?per_page=2`).pipe(
          requestHeaders(jwt),
        );
        const httpResponse = yield* execute("discover-installation", request);
        const installations = yield* HttpClientResponse.schemaBodyJson(InstallationsResponse)(
          httpResponse,
        ).pipe(Effect.mapError(() => invalidResponse("discover-installation")));
        if (installations.length === 0) {
          return yield* new InstallationDiscoveryError({
            reason: "missing",
            message: "The GitHub App is not installed on an account",
          });
        }
        if (installations.length > 1) {
          return yield* new InstallationDiscoveryError({
            reason: "multiple",
            message: "The GitHub App must have exactly one installation for this factory",
          });
        }
        const installationResponse = installations[0];
        if (installationResponse === undefined) {
          return yield* new InvalidGitHubResponseError({
            operation: "discover-installation",
            message: "GitHub returned an empty installation result",
          });
        }
        if (installationResponse.suspendedAt !== null) {
          return yield* new InstallationDiscoveryError({
            reason: "suspended",
            message: "The GitHub App installation is suspended",
          });
        }
        const missing = missingPermissions(installationResponse.permissions);
        if (missing.length > 0) {
          return yield* new AppPermissionError({
            missing,
            message: `The GitHub App installation is missing permissions: ${missing.join(", ")}`,
          });
        }
        return new Installation({
          id: installationResponse.id,
          accountLogin: installationResponse.account.login,
        });
      });

      const mintToken = Effect.fn("GitHubApp.mintToken")(function* (mint: MintRequest) {
        const jwt = yield* jwtSigner.sign(credentials);
        const request = HttpClientRequest.post(
          `${API_ROOT}/app/installations/${mint.installationId}/access_tokens`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe(mint.body), requestHeaders(jwt));
        const httpResponse = yield* execute(mint.operation, request);
        const response = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(httpResponse).pipe(
          Effect.mapError(() => invalidResponse(mint.operation)),
        );
        const receivedAt = yield* Clock.currentTimeMillis;
        const lifetime = DateTime.toEpochMillis(response.expiresAt) - receivedAt;
        if (lifetime <= 0 || lifetime > TOKEN_MAX_LIFETIME_MS) {
          return yield* new InvalidGitHubResponseError({
            operation: mint.operation,
            message: "GitHub returned an installation token outside the one-hour lifetime bound",
          });
        }
        if (mint.scope._tag === "SingleRepository") {
          if (
            Option.isNone(response.repositories) ||
            response.repositories.value.length !== 1 ||
            response.repositories.value[0]?.name.toLowerCase() !==
              mint.scope.repository.toLowerCase()
          ) {
            return yield* new InvalidGitHubResponseError({
              operation: mint.operation,
              message: "GitHub did not confirm that the worker token is scoped to exactly one repo",
            });
          }
        }
        return new InstallationToken({
          value: Redacted.make(response.token, { label: "GitHub installation token" }),
          expiresAt: response.expiresAt,
          scope: mint.scope,
        });
      });

      const mintInstallationToken = Effect.fn("GitHubApp.mintInstallationToken")(
        (installationId: InstallationId) =>
          mintToken({
            installationId,
            operation: "mint-installation-token",
            body: { permissions: REQUIRED_REPOSITORY_PERMISSIONS },
            scope: new InstallationWide(),
          }),
      );

      const mintWorkerToken = Effect.fn("GitHubApp.mintWorkerToken")((project: CoveredProject) =>
        mintToken({
          installationId: project.installationId,
          operation: "mint-worker-token",
          body: {
            permissions: REQUIRED_REPOSITORY_PERMISSIONS,
            repository_ids: [project.repositoryId],
          },
          scope: new SingleRepository({ repository: project.repository }),
        }),
      );

      const repositories = Effect.fn("GitHubApp.repositories")(function* (
        token: InstallationToken,
      ) {
        const collect = (
          page: number,
          accumulated: ReadonlyArray<typeof RepositoryResponse.Type>,
        ): Effect.Effect<
          ReadonlyArray<typeof RepositoryResponse.Type>,
          GitHubApiError | InvalidGitHubResponseError
        > =>
          Effect.suspend(() => {
            const request = HttpClientRequest.get(
              `${API_ROOT}/installation/repositories?per_page=100&page=${page}`,
            ).pipe(requestHeaders(token.value));
            return execute("list-installation-repositories", request).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(RepositoriesResponse)),
              Effect.mapError((error) =>
                error instanceof GitHubApiError
                  ? error
                  : invalidResponse("list-installation-repositories"),
              ),
              Effect.flatMap((response) => {
                const all = [...accumulated, ...response.repositories];
                if (all.length >= response.totalCount) return Effect.succeed(all);
                if (response.repositories.length === 0) {
                  return new InvalidGitHubResponseError({
                    operation: "list-installation-repositories",
                    message:
                      "GitHub pagination ended before total_count repositories were returned",
                  });
                }
                return collect(page + 1, all);
              }),
            );
          });
        return yield* collect(1, []);
      });

      const installation = Effect.fn("GitHubApp.installation")(() =>
        discoverInstallation().pipe(
          Effect.catchDefect(() => adapterDefect("discover-installation")),
        ),
      );

      const installationToken = Effect.fn("GitHubApp.installationToken")(() =>
        Effect.gen(function* () {
          const installation = yield* discoverInstallation();
          return yield* mintInstallationToken(installation.id);
        }).pipe(Effect.catchDefect(() => adapterDefect("mint-installation-token"))),
      );

      const projectAccess = Effect.fn("GitHubApp.projectAccess")(
        (registry: ReadonlyArray<Repository.Name>) =>
          Effect.gen(function* () {
            const installation = yield* discoverInstallation();
            const token = yield* mintInstallationToken(installation.id);
            const installed = yield* repositories(token);
            return deriveProjectAccess(installation, registry, installed);
          }).pipe(Effect.catchDefect(() => adapterDefect("discover-project-access"))),
      );

      const workerToken = Effect.fn("GitHubApp.workerToken")((project: CoveredProject) =>
        mintWorkerToken(project).pipe(Effect.catchDefect(() => adapterDefect("mint-worker-token"))),
      );

      return { installation, installationToken, projectAccess, workerToken };
    }).pipe(Effect.provide(AppJwtSigner.layer)),
  );
}

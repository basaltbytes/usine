import { Repository } from "@usine/core";
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  SynchronizedRef,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import { appJwtSigner } from "./jwt.ts";
import {
  type AppAuthenticationError,
  AppPermissionError,
  type CoveredProject,
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
  type InstalledRepository,
  type ProjectAccess,
  REQUIRED_REPOSITORY_PERMISSIONS,
  RepositoryId,
  SingleRepository,
  type TokenScope,
  deriveProjectAccess,
  missingPermissions,
} from "./model.ts";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const TOKEN_MAX_LIFETIME_MS = 60 * 60 * 1_000;
/** Renew the shared lease once its token has less than this left to live. */
const LEASE_RENEWAL_MARGIN_MS = 5 * 60 * 1_000;

/** What the orchestrator acts under: one discovered installation and one installation-wide token. */
interface Lease {
  readonly installation: Installation;
  readonly token: InstallationToken;
}

const InstallationResponse = Schema.Struct({
  id: InstallationId,
  account: Schema.Struct({ login: Schema.NonEmptyString }),
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

const authorized = (credential: Redacted.Redacted<string>) =>
  HttpClientRequest.setHeaders({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${Redacted.value(credential)}`,
    "user-agent": "usine",
    "x-github-api-version": API_VERSION,
  });

const apiError = (operation: GitHubOperation, error: HttpClientError) =>
  new GitHubApiError({
    operation,
    status: error.response === undefined ? Option.none() : Option.some(error.response.status),
    message:
      error.response === undefined
        ? "The request to GitHub could not be sent"
        : `GitHub rejected the request with status ${error.response.status}`,
  });

/** One token mint, described by its scope: what to ask for and what to call it. */
const mintPlan = (scope: TokenScope): { operation: GitHubOperation; body: Schema.Json } =>
  scope._tag === "InstallationWide"
    ? {
        operation: "mint-installation-token",
        body: { permissions: REQUIRED_REPOSITORY_PERMISSIONS },
      }
    : {
        operation: "mint-worker-token",
        body: {
          permissions: REQUIRED_REPOSITORY_PERMISSIONS,
          repository_ids: [scope.repositoryId],
        },
      };

/**
 * Whole GitHub identity for one usine instance. The transport is supplied as
 * an Effect HttpClient, so the root entry remains platform-free.
 *
 * The orchestrator-side operations share one lease — a single discovery and
 * installation-wide mint reused until the token nears expiry — so polling does
 * not spend two App requests per call. Worker tokens are minted per call.
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
  static readonly layer: Layer.Layer<
    GitHubApp,
    AppAuthenticationError,
    GitHubCredentials | HttpClient.HttpClient
  > = Layer.effect(
    GitHubApp,
    Effect.gen(function* () {
      const credentials = yield* GitHubCredentials;
      const sign = yield* appJwtSigner(credentials);
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

      /** Send one request and parse its JSON body; every other outcome is a typed error. */
      const fetchJson = <S extends Schema.Codec<unknown, unknown, never, unknown>>(
        operation: GitHubOperation,
        request: HttpClientRequest.HttpClientRequest,
        schema: S,
      ): Effect.Effect<S["Type"], GitHubApiError | InvalidGitHubResponseError> =>
        http.execute(request).pipe(
          Effect.mapError((error) => apiError(operation, error)),
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(schema)(response).pipe(
              Effect.mapError(
                () =>
                  new InvalidGitHubResponseError({
                    operation,
                    message: "GitHub returned a response that does not match its API contract",
                  }),
              ),
            ),
          ),
        );

      const discoverInstallation = Effect.fn("GitHubApp.discoverInstallation")(function* () {
        const jwt = yield* sign();
        const [found, ...others] = yield* fetchJson(
          "discover-installation",
          HttpClientRequest.get(`${API_ROOT}/app/installations?per_page=2`).pipe(authorized(jwt)),
          InstallationsResponse,
        );
        if (found === undefined) {
          return yield* new InstallationDiscoveryError({
            reason: "missing",
            message: "The GitHub App is not installed on an account",
          });
        }
        if (others.length > 0) {
          return yield* new InstallationDiscoveryError({
            reason: "multiple",
            message: "The GitHub App must have exactly one installation for this factory",
          });
        }
        if (found.suspendedAt !== null) {
          return yield* new InstallationDiscoveryError({
            reason: "suspended",
            message: "The GitHub App installation is suspended",
          });
        }
        const missing = missingPermissions(found.permissions);
        if (missing.length > 0) {
          return yield* new AppPermissionError({
            missing,
            message: `The GitHub App installation is missing permissions: ${missing.join(", ")}`,
          });
        }
        return new Installation({ id: found.id, accountLogin: found.account.login });
      });

      const mintToken = Effect.fn("GitHubApp.mintToken")(function* (
        installationId: InstallationId,
        scope: TokenScope,
      ) {
        const { operation, body } = mintPlan(scope);
        const jwt = yield* sign();
        const response = yield* fetchJson(
          operation,
          HttpClientRequest.post(
            `${API_ROOT}/app/installations/${installationId}/access_tokens`,
          ).pipe(HttpClientRequest.bodyJsonUnsafe(body), authorized(jwt)),
          TokenResponse,
        );
        const lifetime =
          DateTime.toEpochMillis(response.expiresAt) - (yield* Clock.currentTimeMillis);
        if (lifetime <= 0 || lifetime > TOKEN_MAX_LIFETIME_MS) {
          return yield* new InvalidGitHubResponseError({
            operation,
            message: "GitHub returned an installation token outside the one-hour lifetime bound",
          });
        }
        const confirmed = Option.getOrElse(response.repositories, () => []);
        if (
          scope._tag === "SingleRepository" &&
          !(confirmed.length === 1 && confirmed.every((repo) => repo.id === scope.repositoryId))
        ) {
          return yield* new InvalidGitHubResponseError({
            operation,
            message: "GitHub did not confirm that the worker token is scoped to exactly one repo",
          });
        }
        return new InstallationToken({
          value: Redacted.make(response.token),
          expiresAt: response.expiresAt,
          scope,
        });
      });

      const installedRepositories = Effect.fn("GitHubApp.installedRepositories")(function* (
        token: InstallationToken,
      ) {
        const installed: Array<InstalledRepository> = [];
        for (let page = 1; ; page += 1) {
          const response = yield* fetchJson(
            "list-installation-repositories",
            HttpClientRequest.get(
              `${API_ROOT}/installation/repositories?per_page=100&page=${page}`,
            ).pipe(authorized(token.value)),
            RepositoriesResponse,
          );
          installed.push(...response.repositories);
          if (installed.length >= response.totalCount) return installed;
          if (response.repositories.length === 0) {
            return yield* new InvalidGitHubResponseError({
              operation: "list-installation-repositories",
              message: "GitHub pagination ended before total_count repositories were returned",
            });
          }
        }
      });

      const leaseRef = yield* SynchronizedRef.make(Option.none<Lease>());

      /** The current lease, renewed under the margin; renewals are serialized by the ref. */
      const lease = Effect.fn("GitHubApp.lease")(() =>
        SynchronizedRef.modifyEffect(leaseRef, (current) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (
              Option.isSome(current) &&
              DateTime.toEpochMillis(current.value.token.expiresAt) - now > LEASE_RENEWAL_MARGIN_MS
            ) {
              const kept: [Lease, Option.Option<Lease>] = [current.value, current];
              return kept;
            }
            const installation = yield* discoverInstallation();
            const token = yield* mintToken(installation.id, new InstallationWide());
            const renewed: Lease = { installation, token };
            const stored: [Lease, Option.Option<Lease>] = [renewed, Option.some(renewed)];
            return stored;
          }),
        ),
      );

      return {
        installation: Effect.fn("GitHubApp.installation")(() =>
          Effect.map(lease(), (current) => current.installation),
        ),
        installationToken: Effect.fn("GitHubApp.installationToken")(() =>
          Effect.map(lease(), (current) => current.token),
        ),
        projectAccess: Effect.fn("GitHubApp.projectAccess")(function* (
          registry: ReadonlyArray<Repository.Name>,
        ) {
          const { installation, token } = yield* lease();
          const installed = yield* installedRepositories(token);
          return deriveProjectAccess(installation, registry, installed);
        }),
        workerToken: Effect.fn("GitHubApp.workerToken")((project: CoveredProject) =>
          mintToken(
            project.installationId,
            new SingleRepository({
              repository: project.repository,
              repositoryId: project.repositoryId,
            }),
          ),
        ),
      };
    }),
  );
}

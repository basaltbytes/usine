import type { LoopPermissions } from "@usine/core/loop";
import { RepositoryName } from "@usine/core/repository";
import { BotAccount, BotLogin, BotUserId } from "@usine/core/worker";
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
import { appJwtSigner } from "./jwt.ts";
import {
  API_ROOT,
  authorized,
  invalidResponse,
  statusError,
  transportError,
  withGitHubReason,
} from "./http.ts";
import { type AppAuthenticationError, GitHubCredentials } from "./credentials.ts";
import {
  AppPermissionError,
  type CoveredProject,
  type InstalledRepository,
  type ProjectAccess,
  REQUIRED_REPOSITORY_PERMISSIONS,
  WORKER_TOKEN_PERMISSIONS,
  deriveProjectAccess,
  missingPermissions,
} from "./access.ts";
import {
  type GitHubApiError,
  type GitHubAppError,
  type GitHubRateLimitError,
  type GitHubOperation,
  InvalidGitHubResponseError,
} from "./error.ts";
import {
  AppSlug,
  Installation,
  InstallationDiscoveryError,
  InstallationId,
  InstallationToken,
  InstallationWide,
  RepositoryId,
  SingleRepository,
  type TokenScope,
} from "./installation.ts";

const TOKEN_MAX_LIFETIME_MS = 60 * 60 * 1_000;
/** The margin for clock skew between GitHub and this machine when checking token expiry, in milliseconds. */
const TOKEN_CLOCK_SKEW_MARGIN_MS = 3 * 60 * 1_000;
/** The remaining token lifetime below which the shared lease is renewed, in milliseconds. */
const LEASE_RENEWAL_MARGIN_MS = 5 * 60 * 1_000;

/** The installation and its installation-wide orchestrator token. */
interface Lease {
  readonly installation: Installation;
  readonly token: InstallationToken;
}

const InstallationResponse = Schema.Struct({
  id: InstallationId,
  appSlug: AppSlug,
  account: Schema.Struct({ login: Schema.NonEmptyString }),
  permissions: Schema.Record(Schema.String, Schema.String),
  suspendedAt: Schema.NullOr(Schema.String),
}).pipe(Schema.encodeKeys({ appSlug: "app_slug", suspendedAt: "suspended_at" }));

const InstallationsResponse = Schema.Array(InstallationResponse);

const UserResponse = Schema.Struct({ login: BotLogin, id: BotUserId });

const RepositoryResponse = Schema.Struct({
  id: RepositoryId,
  name: RepositoryName,
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

/** Returns the operation name and request body for minting a token of `scope`. */
const mintPlan = (scope: TokenScope): { operation: GitHubOperation; body: Schema.Json } =>
  scope._tag === "InstallationWide"
    ? {
        operation: "mint-installation-token",
        body: { permissions: REQUIRED_REPOSITORY_PERMISSIONS },
      }
    : {
        operation: "mint-worker-token",
        body: {
          permissions: WORKER_TOKEN_PERMISSIONS[scope.permissions],
          repository_ids: [scope.repositoryId],
        },
      };

/**
 * The factory's GitHub App identity and repository access. Orchestrator operations share an
 * installation-wide token; each Worker token is minted for its Attempt's repository.
 */
export class GitHubApp extends Context.Service<
  GitHubApp,
  {
    /** Returns the App installation after checking its required permissions. */
    readonly installation: () => Effect.Effect<Installation, GitHubAppError>;
    /**
     * Returns the App's bot account, `<slug>[bot]`, read from GitHub's users API once per App
     * slug.
     */
    readonly botAccount: () => Effect.Effect<BotAccount, GitHubAppError>;
    /** Returns the shared installation-wide token for orchestrator operations, renewing it near expiry. */
    readonly installationToken: () => Effect.Effect<InstallationToken, GitHubAppError>;
    /** Returns the access of every registry repository, with each uncovered Project as its own error. */
    readonly projectAccess: (
      registry: ReadonlyArray<RepositoryName>,
    ) => Effect.Effect<ReadonlyArray<ProjectAccess>, GitHubAppError>;
    /**
     * Mints a new Worker token for the covered Project's repository, with the permissions
     * `WORKER_TOKEN_PERMISSIONS` lists for the Loop permission level.
     */
    readonly workerToken: (
      project: CoveredProject,
      permissions: LoopPermissions,
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
      const http = yield* HttpClient.HttpClient;

      /** Sends one request and decodes its JSON body. Fails with a typed GitHub error otherwise. */
      const fetchJson = <S extends Schema.Codec<unknown, unknown, never, unknown>>(
        operation: GitHubOperation,
        request: HttpClientRequest.HttpClientRequest,
        schema: S,
      ): Effect.Effect<
        S["Type"],
        GitHubApiError | GitHubRateLimitError | InvalidGitHubResponseError
      > =>
        Effect.gen(function* () {
          const response = yield* http
            .execute(request)
            .pipe(Effect.mapError((error) => transportError(operation, error)));
          if (response.status < 200 || response.status >= 300) {
            const failure = statusError(operation, response, yield* Clock.currentTimeMillis);
            if (failure._tag === "GitHubRateLimitError") return yield* failure;
            const explained = yield* withGitHubReason(failure, response);
            return yield* explained;
          }
          return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
            Effect.mapError((error) => invalidResponse(operation, error.message)),
          );
        });

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
            message:
              "The GitHub App is not installed on any account. Install it on the account that owns the repositories.",
          });
        }
        if (others.length > 0) {
          return yield* new InstallationDiscoveryError({
            reason: "multiple",
            message:
              "The GitHub App has more than one installation. Uninstall it from every account except one.",
          });
        }
        if (found.suspendedAt !== null) {
          return yield* new InstallationDiscoveryError({
            reason: "suspended",
            message:
              "The GitHub App installation is suspended. Unsuspend it in the installation settings on GitHub.",
          });
        }
        const missing = missingPermissions(found.permissions);
        if (missing.length > 0) {
          return yield* new AppPermissionError({
            missing,
            message: `The GitHub App installation is missing permissions: ${missing.join(", ")}. Grant them in the GitHub App settings, then approve the change on the installation.`,
          });
        }
        return new Installation({
          id: found.id,
          accountLogin: found.account.login,
          appSlug: found.appSlug,
        });
      });

      const mintToken = Effect.fn("GitHubApp.mintToken")(function* (
        installationId: InstallationId,
        scope: TokenScope,
      ) {
        const { operation, body } = mintPlan(scope);
        yield* Effect.annotateCurrentSpan({
          installationId,
          operation,
          scope: scope._tag,
          permissions: scope._tag === "SingleRepository" ? scope.permissions : "installation",
        });
        const jwt = yield* sign();
        const response = yield* fetchJson(
          operation,
          HttpClientRequest.post(
            `${API_ROOT}/app/installations/${installationId}/access_tokens`,
          ).pipe(HttpClientRequest.bodyJsonUnsafe(body), authorized(jwt)),
          TokenResponse,
        );
        const now = yield* Clock.currentTimeMillis;
        const lifetime = DateTime.toEpochMillis(response.expiresAt) - now;
        if (lifetime <= 0 || lifetime > TOKEN_MAX_LIFETIME_MS + TOKEN_CLOCK_SKEW_MARGIN_MS) {
          return yield* new InvalidGitHubResponseError({
            operation,
            message:
              "GitHub returned an installation token that is expired or exceeds the one-hour lifetime limit",
            detail: `expires_at ${DateTime.formatIso(response.expiresAt)} is ${lifetime}ms from now`,
          });
        }
        if (lifetime > TOKEN_MAX_LIFETIME_MS) {
          yield* Effect.logInfo("Accepted GitHub token clock skew; capped the local lease", {
            installationId,
            operation,
            skewMillis: lifetime - TOKEN_MAX_LIFETIME_MS,
          });
        }
        const confirmed = Option.getOrElse(response.repositories, () => []);
        if (
          scope._tag === "SingleRepository" &&
          !(confirmed.length === 1 && confirmed.every((repo) => repo.id === scope.repositoryId))
        ) {
          return yield* new InvalidGitHubResponseError({
            operation,
            message:
              "GitHub did not confirm that the worker token is scoped to exactly one repository",
            detail: `expected repository ID ${scope.repositoryId}, got [${confirmed.map((repo) => repo.id).join(", ")}]`,
          });
        }
        return new InstallationToken({
          value: Redacted.make(response.token),
          expiresAt: DateTime.makeUnsafe(now + Math.min(lifetime, TOKEN_MAX_LIFETIME_MS)),
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
              message: "GitHub returned an empty page before it listed total_count repositories",
              detail: `page ${page} was empty after ${installed.length} of ${response.totalCount} repositories`,
            });
          }
        }
      });

      const leaseRef = yield* SynchronizedRef.make(Option.none<Lease>());

      /** Returns the current lease, renewing it inside the ref if its token is within the margin. */
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

      const botAccountRef = yield* SynchronizedRef.make(
        Option.none<{ readonly appSlug: AppSlug; readonly account: BotAccount }>(),
      );

      const botAccount = Effect.fn("GitHubApp.botAccount")(() =>
        SynchronizedRef.modifyEffect(botAccountRef, (current) =>
          Effect.gen(function* () {
            const { installation, token } = yield* lease();
            const { appSlug } = installation;
            yield* Effect.annotateCurrentSpan({ appSlug });
            if (Option.isSome(current) && current.value.appSlug === appSlug) {
              const kept: [BotAccount, typeof current] = [current.value.account, current];
              return kept;
            }
            const user = yield* fetchJson(
              "read-bot-account",
              HttpClientRequest.get(
                `${API_ROOT}/users/${encodeURIComponent(`${appSlug}[bot]`)}`,
              ).pipe(authorized(token.value)),
              UserResponse,
            );
            const account = new BotAccount(user);
            yield* Effect.logInfo("Read the App's bot account", {
              appSlug,
              login: account.login,
              id: account.id,
            });
            const stored: [BotAccount, typeof current] = [
              account,
              Option.some({ appSlug, account }),
            ];
            return stored;
          }),
        ),
      );

      return {
        installation: Effect.fn("GitHubApp.installation")(() =>
          Effect.map(lease(), (current) => current.installation),
        ),
        botAccount,
        installationToken: Effect.fn("GitHubApp.installationToken")(() =>
          Effect.map(lease(), (current) => current.token),
        ),
        projectAccess: Effect.fn("GitHubApp.projectAccess")(function* (
          registry: ReadonlyArray<RepositoryName>,
        ) {
          const { installation, token } = yield* lease();
          const installed = yield* installedRepositories(token);
          return deriveProjectAccess(installation, registry, installed);
        }),
        workerToken: Effect.fn("GitHubApp.workerToken")(
          (project: CoveredProject, permissions: LoopPermissions) =>
            mintToken(
              project.installationId,
              new SingleRepository({
                repository: project.repository,
                repositoryId: project.repositoryId,
                permissions,
              }),
            ),
        ),
      };
    }),
  );
}

export {
  REQUIRED_REPOSITORY_PERMISSIONS,
  WORKER_TOKEN_PERMISSIONS,
  deriveProjectAccess,
  missingPermissions,
  type InstalledRepository,
  type RequiredRepositoryPermission,
  CoveredProject,
  ProjectNotInstalledError,
  ProjectAccess,
  AppPermissionError,
} from "./access.ts";
export {
  AppId,
  PrivateKey,
  RedactedPrivateKey,
  AppCredentials,
  GitHubCredentials,
  AppAuthenticationError,
} from "./credentials.ts";
export {
  AppSlug,
  InstallationId,
  RepositoryId,
  Installation,
  InstallationWide,
  SingleRepository,
  TokenScope,
  InstallationToken,
  InstallationDiscoveryReason,
  InstallationDiscoveryError,
} from "./installation.ts";
export {
  GitHubOperation,
  GitHubApiError,
  GitHubRateLimitError,
  InvalidGitHubResponseError,
  GitHubAppError,
  isRefusal,
} from "./error.ts";

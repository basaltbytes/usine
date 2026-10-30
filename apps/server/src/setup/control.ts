import type { SetupState } from "@usine/orchestrator/operator";
import type { InstanceDirectory } from "@usine/core/instance";
import {
  GitHubApp,
  GitHubCredentials,
  REQUIRED_REPOSITORY_PERMISSIONS,
} from "@usine/github/github-app";
import {
  GITHUB_APP_SECRETS_PATH,
  GitHubAppSecrets,
  GitHubAppSecretsFromJson,
  loadLocalCredentials,
  writeLocalSecrets,
} from "@usine/github/local-secrets";
import {
  Clock,
  Context,
  Config,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { AuthServices } from "../auth/http.ts";
import { authFailure, type AuthError, type TokenHash } from "../auth/model.ts";
import { randomSecret, secretHash } from "../auth/crypto.ts";
import { ManifestRequest, ManifestResponse } from "./model.ts";

const makeSetup = Effect.fn("Setup.make")(function* (
  directory: InstanceDirectory,
  registered: Effect.Effect<boolean>,
  auth: AuthServices,
  mode: "setup" | "runtime",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const changed = yield* Deferred.make<void>();
  const lock = yield* Semaphore.make(1);
  const pending = new Map<TokenHash, number>();
  const marker = path.join(directory, ".usine/github-app-setup");
  const origin = auth.authentication.origin;
  const fileServices = Layer.merge(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(Path.Path, path),
  );
  const credentials = loadLocalCredentials(directory).pipe(Effect.provide(fileServices));
  const appLayer = (value: GitHubCredentials["Service"]) =>
    GitHubApp.layer.pipe(
      Layer.provide(Layer.succeed(GitHubCredentials, value)),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );
  const needsCredentials = Effect.gen(function* () {
    if (Result.isSuccess(yield* credentials.pipe(Effect.result)))
      return yield* authFailure(
        "This instance already has App credentials. Continue setup with the saved App.",
        409,
      );
  });
  const save = (secrets: GitHubAppSecrets) =>
    Effect.gen(function* () {
      // Import the signing key before replacing the file.
      yield* Effect.void.pipe(
        Effect.provide(appLayer(secrets)),
        Effect.mapError(() =>
          authFailure(
            "The private key cannot sign for this App. Generate a new RSA key in the App settings.",
            400,
          ),
        ),
      );
      yield* writeLocalSecrets(directory, secrets).pipe(
        Effect.provide(fileServices),
        Effect.mapError((error) => authFailure(error.message, 500)),
      );
    });
  const status = Effect.fn("Setup.status")(function* () {
    const loaded = yield* credentials.pipe(Effect.result);
    if (Result.isFailure(loaded)) {
      const found = yield* Effect.all([
        fs.exists(marker),
        fs.exists(path.join(directory, GITHUB_APP_SECRETS_PATH)),
      ]).pipe(
        Effect.mapError(() =>
          authFailure(
            "Could not inspect the setup files. Check the instance folder permissions.",
            500,
          ),
        ),
      );
      const appId = yield* Config.option(Config.String("USINE_GITHUB_APP_ID")).pipe(
        Effect.mapError(() => authFailure("Could not read the App ID setting.", 500)),
      );
      const state: SetupState =
        found.some(Boolean) || Option.isSome(appId)
          ? { _tag: "MissingKey", message: loaded.failure.message }
          : { _tag: "NoApp" };
      yield* Effect.logInfo("GitHub App setup needs credentials", { state: state._tag });
      return state;
    }
    return yield* Effect.gen(function* () {
      const app = yield* GitHubApp;
      const installation = yield* app.installation().pipe(Effect.result);
      if (Result.isFailure(installation)) {
        const error = installation.failure;
        if (error._tag !== "InstallationDiscoveryError") return yield* error;
        yield* Effect.logInfo("GitHub App setup needs an installation", {
          reason: error.reason,
          appId: loaded.success.appId,
        });
        return {
          _tag: "NeedsInstallation" as const,
          url: yield* app.installationUrl(),
          message: error.message,
        };
      }
      const signIn = (yield* auth.store.members).length === 0;
      const state: SetupState =
        !signIn && (yield* registered)
          ? { _tag: "Ready" }
          : { _tag: "Repositories", signIn, github: yield* auth.github.available };
      yield* Effect.logInfo("GitHub App setup installation found", {
        state: state._tag,
        installationId: installation.success.id,
      });
      return state;
    }).pipe(
      Effect.provide(appLayer(loaded.success)),
      Effect.timeout("20 seconds"),
      Effect.tapError((error) =>
        Effect.logWarning("GitHub App setup inspection failed", {
          appId: loaded.success.appId,
          errorTag: error._tag,
        }),
      ),
      Effect.mapError(() =>
        authFailure(
          "Could not check the GitHub App. Check its key and permissions, then try again.",
          502,
        ),
      ),
    );
  });
  return {
    running: mode === "runtime",
    activate: Effect.fn("Setup.activate")(function* () {
      if (mode === "runtime") {
        yield* Effect.logInfo("GitHub App runtime is already active");
        return;
      }
      yield* credentials.pipe(Effect.mapError((error) => authFailure(error.message, 409)));
      yield* Effect.logInfo("GitHub App runtime activation requested");
      yield* Deferred.succeed(changed, undefined);
    })(),
    changed: Deferred.await(changed),
    status: status(),
    begin: Effect.fn("Setup.begin")((request: typeof ManifestRequest.Type) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* needsCredentials;
          yield* auth.authentication.limit("manifest");
          const now = yield* Clock.currentTimeMillis;
          for (const [key, expires] of pending) if (expires <= now) pending.delete(key);
          const state = Redacted.value(randomSecret());
          pending.set(secretHash(state), now + 10 * 60_000);
          yield* fs.makeDirectory(path.dirname(marker), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(marker, "App creation started\n", { mode: 0o600 })),
            Effect.mapError(() =>
              authFailure(
                "Could not record setup progress. Check the instance folder permissions.",
                500,
              ),
            ),
          );
          const account = Option.match(request.organization, {
            onNone: () => "settings",
            onSome: (organization) => `organizations/${encodeURIComponent(organization)}/settings`,
          });
          yield* Effect.logInfo("GitHub App manifest prepared");
          return {
            state,
            action: `https://github.com/${account}/apps/new?state=${encodeURIComponent(state)}`,
            manifest: JSON.stringify({
              name: request.name,
              url: origin,
              public: false,
              redirect_url: `${origin}/api/setup/callback`,
              callback_urls: [`${origin}/api/auth/callback`],
              setup_url: `${origin}/setup`,
              hook_attributes: {
                active: true,
                url:
                  new URL(origin).protocol === "https:"
                    ? `${origin}/webhooks/github`
                    : "https://usine.invalid/webhooks/github",
              },
              default_permissions: REQUIRED_REPOSITORY_PERMISSIONS,
              default_events: [
                "issues",
                "issue_comment",
                "pull_request",
                "pull_request_review",
                "pull_request_review_comment",
                "push",
                "check_suite",
              ],
            }),
          };
        }),
      ),
    ),
    exchange: Effect.fn("Setup.exchange")((state: string, code: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          const hash = secretHash(state);
          const expires = pending.get(hash);
          pending.delete(hash);
          if (expires === undefined || expires <= (yield* Clock.currentTimeMillis))
            return yield* authFailure(
              "App creation expired or was already completed. Open setup to continue.",
              400,
            );
          yield* needsCredentials;
          const converted = yield* HttpClient.filterStatusOk(client)
            .execute(
              HttpClientRequest.post(
                `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
              ).pipe(
                HttpClientRequest.setHeaders({
                  accept: "application/vnd.github+json",
                  "user-agent": "usine",
                }),
              ),
            )
            .pipe(
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ManifestResponse)),
              Effect.timeout("20 seconds"),
              Effect.tapError((error) =>
                Effect.logWarning("GitHub App manifest conversion failed", {
                  errorTag: error._tag,
                }),
              ),
              Effect.mapError(() =>
                authFailure(
                  "GitHub could not complete App creation. Return to setup to recover the App or create another.",
                  502,
                ),
              ),
            );
          yield* save(
            new GitHubAppSecrets({
              appId: converted.appId,
              privateKey: converted.privateKey,
              clientId: Option.some(converted.clientId),
              clientSecret: Option.some(converted.clientSecret),
              webhookSecret: Option.some(converted.webhookSecret),
            }),
          );
          yield* Effect.logInfo("GitHub App manifest exchanged", { appId: converted.appId });
        }),
      ),
    ),
    restore: Effect.fn("Setup.restore")((source: string) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* needsCredentials;
          const secrets = yield* Schema.decodeUnknownEffect(GitHubAppSecretsFromJson)(source, {
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(() =>
              authFailure(
                "Expected credential JSON with app_id and private_key, plus optional client_id, client_secret, and webhook_secret.",
                400,
              ),
            ),
          );
          yield* save(secrets);
          yield* Effect.logInfo("GitHub App credentials restored", { appId: secrets.appId });
        }),
      ),
    ),
  };
});
export class Setup extends Context.Service<
  Setup,
  {
    readonly running: boolean;
    readonly activate: Effect.Effect<void, AuthError>;
    readonly changed: Effect.Effect<void>;
    readonly status: Effect.Effect<SetupState, AuthError>;
    readonly begin: (
      request: typeof ManifestRequest.Type,
    ) => Effect.Effect<
      { readonly state: string; readonly action: string; readonly manifest: string },
      AuthError
    >;
    readonly exchange: (state: string, code: string) => Effect.Effect<void, AuthError>;
    readonly restore: (source: string) => Effect.Effect<void, AuthError>;
  }
>()("@usine/server/Setup") {
  static readonly layer = (
    directory: InstanceDirectory,
    registered: Effect.Effect<boolean>,
    auth: AuthServices,
    mode: "setup" | "runtime",
  ) => Layer.effect(Setup, makeSetup(directory, registered, auth, mode));
}

import { OperatorLogin } from "@usine/core/operator";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AuthError, authFailure, GitHubIdentity } from "./model.ts";

const ClientId = Schema.NonEmptyString;
const DeviceCode = Schema.Struct({
  device_code: Schema.RedactedFromValue(Schema.NonEmptyString),
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.String.check(Schema.isPattern(/^https:\/\/github\.com\//u)),
  expires_in: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
  interval: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
});
const AccessToken = Schema.Struct({
  access_token: Schema.RedactedFromValue(Schema.NonEmptyString),
});
const OAuthFailure = Schema.Struct({ error: Schema.String });
export class GitHubSignIn extends Context.Service<
  GitHubSignIn,
  {
    readonly available: boolean;
    readonly authorizeUrl: (state: string, callback: string) => Effect.Effect<string, AuthError>;
    readonly web: (code: string, callback: string) => Effect.Effect<GitHubIdentity, AuthError>;
    readonly device: Effect.Effect<typeof DeviceCode.Type, AuthError>;
    readonly poll: (
      code: Redacted.Redacted<string>,
    ) => Effect.Effect<Option.Option<GitHubIdentity>, AuthError>;
    readonly lookup: (login: OperatorLogin) => Effect.Effect<GitHubIdentity, AuthError>;
  }
>()("@usine/server/GitHubSignIn") {}

export const githubSignInLayer = Layer.effect(
  GitHubSignIn,
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const config = yield* Config.all({
      clientId: Config.option(Config.schema(ClientId, "USINE_GITHUB_CLIENT_ID")),
      clientSecret: Config.option(Config.Redacted("USINE_GITHUB_CLIENT_SECRET")),
    }).pipe(
      Effect.mapError(() =>
        authFailure("GitHub user authorization configuration is invalid.", 503),
      ),
    );
    const credentials = Effect.gen(function* () {
      if (Option.isNone(config.clientId) || Option.isNone(config.clientSecret))
        return yield* authFailure(
          "GitHub sign-in is not configured. Use usine sign-in-link on the instance machine.",
          503,
        );
      return { id: config.clientId.value, secret: config.clientSecret.value };
    });
    const request = <A, I>(req: HttpClientRequest.HttpClientRequest, schema: Schema.Codec<A, I>) =>
      client
        .execute(
          req.pipe(
            HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "usine" }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
          Effect.timeout("15 seconds"),
          Effect.mapError(() =>
            authFailure("GitHub authorization failed. Try signing in again.", 502),
          ),
        );
    const identity = (token: Redacted.Redacted<string>) =>
      request(
        HttpClientRequest.get("https://api.github.com/user").pipe(
          HttpClientRequest.bearerToken(token),
        ),
        GitHubIdentity,
      ).pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(token))));
    const exchange = (fields: Record<string, string>) =>
      request(
        HttpClientRequest.post("https://github.com/login/oauth/access_token").pipe(
          HttpClientRequest.bodyUrlParams(fields),
        ),
        Schema.Union([AccessToken, OAuthFailure]),
      );
    return GitHubSignIn.of({
      available: Option.isSome(config.clientId) && Option.isSome(config.clientSecret),
      authorizeUrl: Effect.fn("GitHubSignIn.authorizeUrl")(function* (state, callback) {
        const { id } = yield* credentials;
        const params = new URLSearchParams({ client_id: id, redirect_uri: callback, state });
        return `https://github.com/login/oauth/authorize?${params}`;
      }),
      web: Effect.fn("GitHubSignIn.web")(function* (code, callback) {
        const { id, secret } = yield* credentials;
        const result = yield* exchange({
          client_id: id,
          client_secret: Redacted.value(secret),
          code,
          redirect_uri: callback,
        });
        if ("error" in result)
          return yield* authFailure("GitHub authorization was refused. Try signing in again.", 403);
        return yield* identity(result.access_token);
      }),
      device: Effect.gen(function* () {
        const { id } = yield* credentials;
        return yield* request(
          HttpClientRequest.post("https://github.com/login/device/code").pipe(
            HttpClientRequest.bodyUrlParams({ client_id: id }),
          ),
          DeviceCode,
        );
      }),
      poll: Effect.fn("GitHubSignIn.poll")(function* (code) {
        const { id } = yield* credentials;
        const result = yield* exchange({
          client_id: id,
          device_code: Redacted.value(code),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        if ("error" in result) {
          if (result.error === "authorization_pending") return Option.none();
          if (result.error === "slow_down")
            return yield* authFailure("Wait before checking GitHub authorization again.", 429);
          return yield* authFailure(
            "GitHub device authorization expired or was refused. Start sign-in again.",
            403,
          );
        }
        return Option.some(yield* identity(result.access_token));
      }),
      lookup: Effect.fn("GitHubSignIn.lookup")((login) =>
        request(
          HttpClientRequest.get(`https://api.github.com/users/${encodeURIComponent(login)}`),
          GitHubIdentity,
        ),
      ),
    });
  }),
);

import type { GatewayDomain, WorkerName } from "@usine/core/worker";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { WorkerCapabilityError } from "../../../executor.ts";
import type { BoatTailnet } from "../../model.ts";

const API = "https://api.tailscale.com/api/v2";
const AccessToken = Schema.Struct({
  access_token: Schema.RedactedFromValue(Schema.NonEmptyString),
});
const AuthKey = Schema.Struct({
  id: Schema.NonEmptyString,
  key: Schema.RedactedFromValue(Schema.NonEmptyString),
});

export const tailscaleClientFor = Effect.fn("Tailscale.clientFor")(function* (
  worker: WorkerName,
  settings: BoatTailnet,
) {
  yield* Effect.annotateCurrentSpan({ worker });
  const http = yield* HttpClient.HttpClient;
  const gap = (operation: string, detail: string) =>
    new WorkerCapabilityError({
      worker,
      capability: "gateway",
      message: `Tailscale couldn't ${operation} for worker "${worker}": ${detail}`,
      cause: new Error(detail),
    });
  const send = Effect.fn("Tailscale.request")(function* (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    yield* Effect.annotateCurrentSpan({ worker, operation });
    return yield* http.execute(request).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError(() => gap(operation, "request failed or timed out")),
    );
  });
  const decode =
    <S extends Schema.Constraint>(schema: S, operation: string) =>
    (response: HttpClientResponse.HttpClientResponse) => {
      if (response.status >= 400) return Effect.fail(gap(operation, `HTTP ${response.status}`));
      return HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => gap(operation, "unexpected response body")),
      );
    };

  const acquire = Effect.fn("Tailscale.createAuthKey")(function* () {
    yield* Effect.annotateCurrentSpan({ worker });
    const { access_token: token } = yield* send(
      "authorize the OAuth client",
      HttpClientRequest.post(`${API}/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "client_credentials",
          client_id: Redacted.value(settings.clientId),
          client_secret: Redacted.value(settings.clientSecret),
          scope: "auth_keys",
        }),
      ),
    ).pipe(Effect.flatMap(decode(AccessToken, "authorize the OAuth client")));
    const key = yield* send(
      "create an auth key for tag:usine-attempt",
      HttpClientRequest.post(`${API}/tailnet/-/keys`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe({
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: true,
                preauthorized: true,
                tags: ["tag:usine-attempt"],
              },
            },
          },
          expirySeconds: 600,
          description: `usine worker ${worker}`,
        }),
      ),
    ).pipe(Effect.flatMap(decode(AuthKey, "create an auth key for tag:usine-attempt")));
    yield* Effect.logInfo("Created a single-use ephemeral Tailscale auth key", { worker });
    return { ...key, token };
  });

  const release = Effect.fn("Tailscale.revokeAuthKey")(function* (
    key: Effect.Success<ReturnType<typeof acquire>>,
  ) {
    yield* Effect.annotateCurrentSpan({ worker });
    const response = yield* send(
      "revoke the auth key",
      HttpClientRequest.make("DELETE")(`${API}/tailnet/-/keys/${encodeURIComponent(key.id)}`).pipe(
        HttpClientRequest.bearerToken(key.token),
      ),
    );
    if (response.status >= 400 && response.status !== 404)
      return yield* gap("revoke the auth key", `HTTP ${response.status}`);
    yield* Effect.logInfo("Revoked the Tailscale auth key", { worker });
  });

  const withKey = <A, E, R>(use: (key: Redacted.Redacted<string>) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquire(),
      ({ key }) => use(key),
      (key) =>
        release(key).pipe(
          Effect.tapError((error) => Effect.logWarning(error.message, { worker })),
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              Redacted.wipeUnsafe(key.key);
              Redacted.wipeUnsafe(key.token);
            }),
          ),
        ),
    );

  const verifyGateway = Effect.fn("Tailscale.verifyGateway")(function* (domain: GatewayDomain) {
    yield* Effect.annotateCurrentSpan({ worker, address: settings.gatewayAddress });
    const response = yield* send(
      "connect to the gateway's tailnet address",
      HttpClientRequest.get(`http://${settings.gatewayAddress}/`).pipe(
        HttpClientRequest.setHeader("host", `git.${domain}`),
      ),
    );
    if (response.headers["x-usine-gateway-refusal"] !== "missing-caller-token")
      return yield* gap(
        "connect to the gateway's tailnet address",
        "the gateway did not refuse a missing caller token",
      );
    yield* Effect.logInfo("Gateway answered on its tailnet address", {
      worker,
      address: settings.gatewayAddress,
    });
  });

  return { withKey, verifyGateway };
});

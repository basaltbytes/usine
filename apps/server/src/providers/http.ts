import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { authFailure } from "../auth/model.ts";
import { ProviderApi, BeginRequest, CodeRequest, KeyRequest } from "./api.ts";
import { ProviderLogins } from "./control.ts";

export const providerRoutes = HttpRouter.addAll(
  Object.values(ProviderApi.endpoints).map((endpoint) =>
    HttpRouter.route(
      endpoint.method,
      endpoint.path,
      Effect.gen(function* () {
        const service = yield* Effect.serviceOption(ProviderLogins);
        if (Option.isNone(service))
          return yield* authFailure("Provider connections are unavailable. Restart usine.", 503);
        const logins = service.value;
        switch (endpoint.identifier) {
          case "status": {
            const status = yield* logins.status;
            return HttpServerResponse.jsonUnsafe(status);
          }
          case "begin": {
            const payload = yield* HttpServerRequest.schemaBodyJson(BeginRequest, {
              onExcessProperty: "error",
            });
            const login = yield* logins.begin(payload.target, payload.provider);
            return HttpServerResponse.jsonUnsafe(login);
          }
          case "code": {
            const payload = yield* HttpServerRequest.schemaBodyJson(CodeRequest, {
              onExcessProperty: "error",
            });
            yield* logins.submit(payload.id, payload.code);
            break;
          }
          case "key": {
            const payload = yield* HttpServerRequest.schemaBodyJson(KeyRequest, {
              onExcessProperty: "error",
            });
            yield* logins.apiKey(payload.target, payload.provider, payload.key);
            break;
          }
          case "disconnect": {
            const payload = yield* HttpServerRequest.schemaBodyJson(BeginRequest, {
              onExcessProperty: "error",
            });
            yield* logins.disconnect(payload.target, payload.provider);
            break;
          }
          case "cancel": {
            const { params } = yield* HttpRouter.RouteContext;
            yield* logins.cancel(params.id ?? "");
          }
        }
        return HttpServerResponse.jsonUnsafe({ ok: true });
      }).pipe(
        Effect.catchTags({
          ProviderCredentialError: (error) => authFailure(error.message, 503),
          SchemaError: () => authFailure("Invalid provider connection request.", 400),
          HttpServerError: () =>
            authFailure("Could not read the provider connection request.", 400),
        }),
      ),
    ),
  ),
);

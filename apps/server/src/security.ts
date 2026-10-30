import { type UiOrigin } from "@usine/config/factory";
import { Effect, Schema } from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

export const CrossSiteRequestError = Schema.Struct({
  error: Schema.Literal("CrossSiteRequestError"),
  message: Schema.String,
});

const METHODS = ["GET", "POST", "PUT", "DELETE"];
const REQUEST_HEADERS = ["authorization", "content-type", "x-usine-csrf"];
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
};

export const securityMiddleware = (options: {
  readonly origin: UiOrigin;
  readonly origins: ReadonlyArray<UiOrigin>;
}) => {
  const origins = new Set<string>(options.origins);
  const headers = options.origin.startsWith("https:")
    ? { ...SECURITY_HEADERS, "strict-transport-security": "max-age=31536000" }
    : SECURITY_HEADERS;
  return HttpRouter.middleware(
    (handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const origin = request.headers.origin;
        const allowed = origin !== undefined && origins.has(origin);
        const preflight = request.method === "OPTIONS" && origin !== undefined;
        yield* HttpEffect.appendPreResponseHandler((_, response) => {
          const vary = [response.headers.vary, "Origin"];
          if (preflight)
            vary.push("Access-Control-Request-Method", "Access-Control-Request-Headers");
          const secured = HttpServerResponse.setHeaders(response, {
            ...headers,
            vary: vary.filter((value) => value !== undefined).join(", "),
          });
          return Effect.succeed(
            allowed
              ? HttpServerResponse.setHeaders(secured, {
                  "access-control-allow-origin": origin,
                  "access-control-allow-credentials": "true",
                })
              : secured,
          );
        });
        const refuse = Effect.fn("Http.refuseOrigin")(function* (reason: string) {
          yield* Effect.logWarning("Browser request refused", { reason, method: request.method });
          return HttpServerResponse.jsonUnsafe(
            CrossSiteRequestError.make({
              error: "CrossSiteRequestError",
              message: "Cross-site request is not allowed.",
            }),
            { status: 403 },
          );
        });
        if (origin !== undefined && !allowed) return yield* refuse("origin");
        if (preflight) {
          const method = request.headers["access-control-request-method"] ?? "";
          const requestedHeaders = request.headers["access-control-request-headers"];
          if (!METHODS.includes(method)) return yield* refuse("method");
          if (
            requestedHeaders !== undefined &&
            !requestedHeaders
              .split(",")
              .every((header) => REQUEST_HEADERS.includes(header.trim().toLowerCase()))
          )
            return yield* refuse("headers");
          yield* Effect.logDebug("Browser preflight accepted", { method });
          return HttpServerResponse.empty({
            status: 204,
            headers: {
              "access-control-allow-methods": METHODS.join(", "),
              "access-control-allow-headers": REQUEST_HEADERS.join(", "),
            },
          });
        }
        return yield* handler;
      }),
    { global: true },
  );
};

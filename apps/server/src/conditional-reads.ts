// This synchronous Node crypto boundary requires native key and cipher operations.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/** Validates private JSON reads after authorization and response encoding. */
export const conditionalReads = HttpRouter.middleware((handler) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method === "GET") {
      yield* HttpEffect.appendPreResponseHandler((_, response) => {
        if (
          response.status !== 200 ||
          response.body._tag !== "Uint8Array" ||
          response.body.contentType !== "application/json"
        )
          return Effect.succeed(response);
        // Weak, so that the validator holds for every content encoding of the representation.
        const tag = `"${createHash("sha256").update(response.body.body).digest("hex")}"`;
        const etag = `W/${tag}`;
        const headers = {
          etag,
          "cache-control": "private, no-cache",
          vary: [response.headers.vary, "Cookie", "Authorization", "x-usine-view"]
            .filter(Boolean)
            .join(", "),
        };
        const matches = request.headers["if-none-match"]
          ?.split(",")
          .some(
            (candidate) =>
              candidate.trim().replace(/^W\//u, "") === tag || candidate.trim() === "*",
          );
        return Effect.succeed(
          matches === true
            ? HttpServerResponse.empty({ status: 304, headers })
            : HttpServerResponse.setHeaders(response, headers),
        );
      });
    }
    return yield* handler;
  }),
);

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
        const etag = `"${createHash("sha256").update(response.body.body).digest("hex")}"`;
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
              candidate.trim().replace(/^W\//u, "") === etag || candidate.trim() === "*",
          );
        return Effect.succeed(
          matches
            ? HttpServerResponse.empty({ status: 304, headers })
            : HttpServerResponse.setHeaders(response, headers),
        );
      });
    }
    return yield* handler;
  }),
);

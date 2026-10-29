import { Effect, Option, Result, Schema, Stream } from "effect";
import { Headers, HttpClient, type HttpClientResponse } from "effect/http";
import type { Attachment } from "../attachment/attachment.ts";
import { absoluteUrl, afterPrefix, type GitHubOrigins, type GitHubRoute } from "./github.ts";

const API_DOWNLOAD_PATH =
  /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:actions\/(?:jobs\/\d+\/logs|runs\/\d+(?:\/attempts\/\d+)?\/logs|artifacts\/\d+\/zip)|releases\/assets\/\d+)$/u;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

class DownloadRedirectFailed extends Schema.TaggedError<DownloadRedirectFailed>(
  "DownloadRedirectFailed",
)("DownloadRedirectFailed", {
  reason: Schema.Literals(["invalid-location", "redirect-limit", "upstream-failure"]),
}) {}

/** Only named repository downloads qualify; the caller must first check the attachment serves the repository. */
const isDownload = (origins: GitHubOrigins, route: GitHubRoute): boolean =>
  Option.isSome(route.repository) &&
  (route.protocol === "release" ||
    absoluteUrl(route.upstream).pipe(
      Option.flatMap((url) => afterPrefix(`${url.origin}${url.pathname}`, origins.api)),
      Option.exists((path) => API_DOWNLOAD_PATH.test(path)),
    ));

const follow = Effect.fn("GatewayProxy.followDownloadRedirects")(
  function* (
    client: HttpClient.HttpClient,
    origins: GitHubOrigins,
    attachment: Attachment,
    initial: HttpClientResponse.HttpClientResponse,
  ) {
    const fields = {
      attachment: attachment.id,
      worker: attachment.worker,
      repository: attachment.repository,
    };
    yield* Effect.annotateCurrentSpan(fields);
    let response = initial;
    let redirects = 0;
    while (REDIRECTS.has(response.status)) {
      const location = Option.flatMap(Headers.get(response.headers, "location"), (value) =>
        Result.getSuccess(Result.try(() => new URL(value, response.request.url))),
      );
      // GitHub redirects still pass through the gateway's repository and rename checks.
      if (
        redirects === 0 &&
        Option.isSome(location) &&
        [origins.web, origins.api].some((origin) =>
          Option.isSome(afterPrefix(`${location.value.origin}${location.value.pathname}`, origin)),
        )
      ) {
        yield* Effect.logDebug("Left a GitHub download redirect for repository checks", fields);
        return response;
      }
      yield* Stream.runHead(response.stream).pipe(
        Effect.mapError(() => new DownloadRedirectFailed({ reason: "upstream-failure" })),
      );
      if (
        Option.isNone(location) ||
        location.value.protocol !== "https:" ||
        location.value.username !== "" ||
        location.value.password !== ""
      )
        return yield* new DownloadRedirectFailed({ reason: "invalid-location" });
      if (redirects === MAX_REDIRECTS)
        return yield* new DownloadRedirectFailed({ reason: "redirect-limit" });
      redirects += 1;
      yield* Effect.logInfo("Following a GitHub download redirect without credentials", {
        ...fields,
        target: location.value.host,
        status: response.status,
        redirect: redirects,
      });
      response = yield* client
        .get(location.value.href)
        .pipe(Effect.mapError(() => new DownloadRedirectFailed({ reason: "upstream-failure" })));
    }
    yield* Effect.logInfo("Received a GitHub download response", {
      ...fields,
      redirects,
      status: response.status,
    });
    return response;
  },
  (effect, _client, _origins, attachment) =>
    effect.pipe(
      Effect.tapError(({ reason }) =>
        Effect.logWarning("Could not follow a GitHub download redirect", {
          attachment: attachment.id,
          worker: attachment.worker,
          repository: attachment.repository,
          reason,
        }),
      ),
    ),
);

/** Follows download redirects with fresh GETs, without worker headers, credentials, or a request body. */
export const githubDownloadClient = (
  client: HttpClient.HttpClient,
  origins: GitHubOrigins,
  attachment: Attachment,
  route: GitHubRoute,
  method: string,
) =>
  HttpClient.transformResponse(
    client,
    Effect.flatMap((response) =>
      method === "GET" && isDownload(origins, route)
        ? follow(client, origins, attachment, response)
        : Effect.succeed(response),
    ),
  );

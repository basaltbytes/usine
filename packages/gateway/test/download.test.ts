import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Stream, Tracer } from "effect";
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { AnonymousCredential, Attachment } from "../src/attachment/attachment.ts";
import { githubDownloadClient } from "../src/github/download.ts";
import { GITHUB_ORIGINS, githubRoute, type GitHubHost } from "../src/github/github.ts";
import { ATTACHMENT, REPOSITORY, WORKER } from "./fixtures.ts";

const attachment = new Attachment({
  id: ATTACHMENT,
  worker: WORKER,
  repository: REPOSITORY,
  credential: new AnonymousCredential(),
  expiresAt: DateTime.makeUnsafe("2026-10-30T00:00:00Z"),
});
const BLOB = "https://productionresultssa18.blob.core.windows.net/logs/job?sig=secret";
const RECEIVER = "https://results-receiver.actions.githubusercontent.com/archive?sig=secret";
const LOGS = "/api/v3/repos/acme/demo/actions/runs/42/logs";

const download = (
  path: string,
  answer: (url: string) => Response,
  method: HttpClientRequest.HttpClientRequest["method"] = "GET",
  host: GitHubHost = "gateway",
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(request.url)));
  });
  const route = githubRoute(GITHUB_ORIGINS, host, path, "");
  assert(Option.isSome(route));
  return {
    requests,
    response: githubDownloadClient(client, GITHUB_ORIGINS, attachment, route.value, method)
      .execute(
        HttpClientRequest.make(method)(route.value.upstream).pipe(
          HttpClientRequest.setHeaders({
            authorization: "Bearer installation-secret",
            "x-api-key": "worker-secret",
            cookie: "worker-cookie",
            "x-usine-gateway-token": "caller-secret",
            "x-worker-header": "private",
          }),
          HttpClientRequest.bodyText("worker body"),
        ),
      )
      .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true)),
  };
};

const redirect = (location: string, status = 302) =>
  new Response("redirect body", { status, headers: { location, "set-cookie": "upstream-cookie" } });

describe("GitHub download redirects", () => {
  it.effect("releases intermediate bodies and streams the final body before it finishes", () =>
    Effect.gen(function* () {
      let canceled = 0;
      const body = () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new Uint8Array([42])),
          cancel: () => {
            canceled += 1;
          },
        });
      const { response } = download(LOGS, (url) =>
        url === BLOB
          ? new Response(body())
          : new Response(body(), { status: 302, headers: { location: BLOB } }),
      );
      const result = yield* response;
      assert.strictEqual(canceled, 1);
      assert.deepStrictEqual(
        yield* Stream.runHead(result.stream),
        Option.some(new Uint8Array([42])),
      );
      assert.strictEqual(canceled, 2);
    }),
  );

  it.effect("keeps signed download URLs out of failed spans", () =>
    Effect.gen(function* () {
      const failures: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            failures.push(JSON.stringify(exit));
            end(endTime, exit);
          };
          return span;
        },
      });
      const client = HttpClient.make((request) =>
        request.url === BLOB
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause: new Error(BLOB) }),
              }),
            )
          : Effect.succeed(HttpClientResponse.fromWeb(request, redirect(BLOB))),
      );
      const route = githubRoute(GITHUB_ORIGINS, "gateway", LOGS, "");
      assert(Option.isSome(route));
      const failure = yield* githubDownloadClient(
        client,
        GITHUB_ORIGINS,
        attachment,
        route.value,
        "GET",
      )
        .get(route.value.upstream)
        .pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.withTracer(tracer),
          Effect.flip,
        );
      assert.strictEqual(failure._tag, "DownloadRedirectFailed");
      if (failure._tag === "DownloadRedirectFailed")
        assert.strictEqual(failure.reason, "upstream-failure");
      assert.isAbove(failures.length, 0);
      assert.isFalse(failures.some((failure) => failure.includes("sig=secret")));
    }),
  );

  it.effect(
    "fetches each supported download with fresh GETs through an unlisted redirect chain",
    () =>
      Effect.gen(function* () {
        for (const path of [
          LOGS,
          "/api/v3/repos/acme/demo/actions/runs/42/attempts/2/logs",
          "/api/v3/repos/acme/demo/actions/jobs/42/logs",
          "/api/v3/repos/acme/demo/actions/artifacts/42/zip",
          "/api/v3/repos/acme/demo/releases/assets/42",
          "/acme/demo/releases/download/cli/v1/tool.tar.gz",
          "/acme/demo/releases/latest/download/tool.tar.gz",
        ]) {
          const { requests, response } = download(path, (url) =>
            url === RECEIVER
              ? redirect(BLOB, 307)
              : url === BLOB
                ? new Response(new Uint8Array([0, 255, 42]), {
                    status: 206,
                    headers: { "content-type": "application/zip", "content-range": "bytes 0-2/3" },
                  })
                : redirect(RECEIVER),
          );
          const result = yield* response;
          assert.strictEqual(result.status, 206, path);
          assert.deepStrictEqual(
            Headers.get(result.headers, "content-range"),
            Option.some("bytes 0-2/3"),
          );
          assert.deepStrictEqual(
            new Uint8Array(yield* result.arrayBuffer),
            new Uint8Array([0, 255, 42]),
          );
          assert.deepStrictEqual(
            requests.slice(1).map(({ url }) => url),
            [RECEIVER, BLOB],
          );
          for (const request of requests.slice(1)) {
            assert.strictEqual(request.method, "GET");
            assert.deepStrictEqual(request.headers, Headers.empty);
            assert.strictEqual(request.body._tag, "Empty");
          }
        }
      }),
  );

  it.effect("does not follow other methods, paths, uploads, or repository-id routes", () =>
    Effect.gen(function* () {
      for (const [host, path, method] of [
        ["gateway", LOGS, "HEAD"],
        ["gateway", LOGS, "POST"],
        ["gateway", "/api/v3/repos/acme/demo/actions/runs/42", "GET"],
        ["gateway", "/api/v3/repos/acme/demo/actions/runs/42/logs/extra", "GET"],
        ["gateway", "/api/v3/repos/acme/demo/actions/runs/42/logs/", "GET"],
        ["gateway", "/api/v3/repos/acme/demo/tarball/main", "GET"],
        ["gateway", "/api/v3/repositories/42/actions/runs/42/logs", "GET"],
        ["gateway", "/api/uploads/repos/acme/demo/releases/assets/42", "GET"],
        ["uploads", "/repos/acme/demo/releases/assets/42", "GET"],
      ] as const) {
        const { requests, response } = download(path, () => redirect(BLOB), method, host);
        const result = yield* response;
        assert.strictEqual(result.status, 302, path);
        assert.deepStrictEqual(Headers.get(result.headers, "location"), Option.some(BLOB));
        assert.strictEqual(requests.length, 1);
        yield* Stream.runDrain(result.stream);
      }
    }),
  );

  it.effect("also follows download URLs requested directly on api.github.com", () =>
    Effect.gen(function* () {
      const { response } = download(
        "/repos/acme/demo/actions/jobs/42/logs",
        (url) => (url === BLOB ? new Response("job log") : redirect(BLOB)),
        "GET",
        "api",
      );
      assert.strictEqual(yield* (yield* response).text, "job log");
    }),
  );

  it.effect(
    "fails after three redirects instead of returning a download-host redirect to the worker",
    () =>
      Effect.gen(function* () {
        const { requests, response } = download(LOGS, () => redirect(BLOB));
        const failure = yield* Effect.flip(response);
        assert.strictEqual(failure._tag, "DownloadRedirectFailed");
        if (failure._tag === "DownloadRedirectFailed")
          assert.strictEqual(failure.reason, "redirect-limit");
        assert.strictEqual(requests.length, 4);
      }),
  );

  it.effect("resolves relative redirects and preserves download error statuses", () =>
    Effect.gen(function* () {
      const { requests, response } = download(LOGS, (url) =>
        url === RECEIVER
          ? redirect("/expired", 303)
          : url.endsWith("/expired")
            ? new Response("expired", { status: 410 })
            : redirect(RECEIVER),
      );
      const result = yield* response;
      assert.strictEqual(result.status, 410);
      assert.strictEqual(yield* result.text, "expired");
      assert.strictEqual(
        requests.at(-1)?.url,
        "https://results-receiver.actions.githubusercontent.com/expired",
      );
    }),
  );

  it.effect(
    "rejects missing, malformed, non-HTTPS, and credential-bearing download locations",
    () =>
      Effect.gen(function* () {
        for (const location of [
          "http://example.com/file",
          "file:///etc/passwd",
          "https://",
          "https://user:secret@example.com/file",
        ]) {
          const { requests, response } = download(LOGS, () => redirect(location));
          const failure = yield* Effect.flip(response);
          assert.strictEqual(failure._tag, "DownloadRedirectFailed");
          if (failure._tag === "DownloadRedirectFailed")
            assert.strictEqual(failure.reason, "invalid-location");
          assert.strictEqual(requests.length, 1);
        }
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(download(LOGS, () => new Response("", { status: 302 })).response),
          ),
        );
      }),
  );
});

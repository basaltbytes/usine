import { jsonKey } from "@usine/core/json-key";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Context, DateTime, Effect, Layer, Logger, Option, Redacted, Ref, Stream } from "effect";
import { Base64 } from "effect/encoding";
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  AnonymousCredential,
  Attachment,
  type AttachmentCredential,
  type AttachmentId,
  InstallationCredential,
} from "../src/attachment/attachment.ts";
import { Attachments } from "../src/attachment/store.ts";
import { CallerClaims, CallerTokens } from "../src/caller/caller.ts";
import { gatewayServices } from "../src/gateway.ts";
import {
  AnthropicApiKey,
  AnthropicProvider,
  AnthropicSubscriptionToken,
  type LlmProviders,
  OpenAiApiKey,
  OpenAiProvider,
} from "../src/llm/llm.ts";
import { GatewayProxy, REFUSAL_HEADER } from "../src/proxy/proxy.ts";
import { UpstreamBase } from "../src/upstream.ts";
import {
  ATTACHMENT,
  NO_PROVIDERS,
  OTHER_ATTACHMENT,
  REPOSITORY,
  WORKER,
  secret,
  settingsLayer,
} from "./fixtures.ts";

const INSTALLATION_TOKEN = "ghs_installationTokenForTests0123456789";
const ANTHROPIC_KEY = "sk-ant-api03-keyForTests0123456789";
const SUBSCRIPTION_TOKEN = "sk-ant-oat01-subscriptionForTests0123456789";
const OPENAI_KEY = "sk-proj-keyForTests0123456789";
const ASSET_URL =
  "https://release-assets.githubusercontent.com/github-production-release-asset/42/asset?sp=r&sig=signature-for-tests";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers.Headers;
  readonly body: string;
}

/** Returns the fake upstream's response to a request for `url`. */
type Answer = (url: URL) => Response;

const ok: Answer = () =>
  new Response("upstream body", { status: 200, headers: { "x-upstream": "yes" } });

/** Answers each URL in `locations` with a redirect to its value, and other URLs with `otherwise`. */
const redirecting =
  (status: number, locations: Readonly<Record<string, string>>, otherwise: Answer = ok): Answer =>
  (url) => {
    const location = locations[url.toString()];
    return location === undefined
      ? otherwise(url)
      : new Response("", { status, headers: { location } });
  };

/**
 * GitHub's API for repository 42, the attached `acme/demo` under its new name `current`: the
 * former name redirects to the repository's id. Other URLs get `otherwise`.
 */
const renamedRepository =
  (current: string, otherwise: Answer = ok): Answer =>
  (url) =>
    url.toString() === "https://api.github.com/repositories/42"
      ? Response.json({ id: 42, full_name: current })
      : redirecting(
          301,
          { "https://api.github.com/repos/acme/demo": "https://api.github.com/repositories/42" },
          otherwise,
        )(url);

/** The requests the fake upstream received, and its answer to each. */
class Upstream extends Context.Service<
  Upstream,
  { readonly sent: Ref.Ref<ReadonlyArray<Sent>>; readonly answer: Answer }
>()("@usine/gateway/test/proxy.test/Upstream") {
  static readonly answering = (answer: Answer) =>
    Layer.effect(
      Upstream,
      Effect.map(Ref.make<ReadonlyArray<Sent>>([]), (sent) => ({ sent, answer })),
    );
}

const fakeClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const { sent, answer } = yield* Upstream;
    return HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Stream"
            ? yield* request.body.stream.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie)
            : "";
        yield* Ref.update(sent, (all) => [
          ...all,
          { method: request.method, url: url.toString(), headers: request.headers, body },
        ]);
        return HttpClientResponse.fromWeb(request, answer(url));
      }),
    );
  }),
);

const lines: Array<string> = [];
const captureLogs = Logger.layer([
  Logger.make(({ message }) => {
    lines.push(jsonKey(message));
  }),
]);

const gateway = (providers: LlmProviders, answer: Answer = ok) =>
  GatewayProxy.layer.pipe(
    Layer.provideMerge(gatewayServices),
    Layer.provide(fakeClient),
    Layer.provideMerge(Upstream.answering(answer)),
    Layer.provideMerge(settingsLayer(providers)),
    Layer.provideMerge(captureLogs),
    Layer.provide(NodeFileSystem.layer),
  );

/** Attaches `credential` for the test Worker and repository under `id` and returns the caller token. */
const attachAs = (id: AttachmentId, credential: AttachmentCredential) =>
  Effect.gen(function* () {
    const attachments = yield* Attachments;
    const callers = yield* CallerTokens;
    const currentNow = yield* DateTime.now;
    yield* attachments.attach(
      Attachment.make({
        id,
        worker: WORKER,
        repository: REPOSITORY,
        credential,
        expiresAt: DateTime.add(currentNow, { hours: 1 }),
      }),
    );
    const callerToken = yield* callers.issue(
      CallerClaims.make({ attachment: id, worker: WORKER, repository: REPOSITORY }),
    );
    return Redacted.value(callerToken);
  });

const attach = (credential: AttachmentCredential) => attachAs(ATTACHMENT, credential);

const installation = InstallationCredential.make({ token: secret(INSTALLATION_TOKEN) });

const send = (url: string, headers: Record<string, string>, init: RequestInit = {}) =>
  Effect.gen(function* () {
    const proxy = yield* GatewayProxy;
    const web = new Request(url, { ...init, headers });
    const request = HttpServerRequest.fromWeb(web);
    const response = yield* proxy.handle.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({ headers: Headers.set(request.headers, "host", new URL(url).host) }),
      ),
    );
    const answer = HttpServerResponse.toWeb(response);
    return {
      status: answer.status,
      headers: answer.headers,
      body: yield* Effect.promise(() => answer.text()),
    };
  });

const sent = Effect.flatMap(Upstream, ({ sent }) => Ref.get(sent));

describe("GatewayProxy", () => {
  it.effect(
    "a git request reaches github.com with the installation token instead of the caller token",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        const response = yield* send(
          "http://git.gw.test/acme/demo.git/info/refs?service=git-upload-pack",
          { "x-usine-gateway-token": caller, "git-protocol": "version=2" },
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("x-upstream"), "yes");
        const [request] = yield* sent;
        assert(request !== undefined);
        assert.strictEqual(
          request.url,
          "https://github.com/acme/demo.git/info/refs?service=git-upload-pack",
        );
        assert.deepStrictEqual(
          Headers.get(request.headers, "authorization"),
          Option.some(`Basic ${Base64.encode(`x-access-token:${INSTALLATION_TOKEN}`)}`),
        );
        assert.deepStrictEqual(
          Headers.get(request.headers, "git-protocol"),
          Option.some("version=2"),
        );
        assert.isTrue(Option.isNone(Headers.get(request.headers, "x-usine-gateway-token")));
      }).pipe(Effect.provide(gateway(NO_PROVIDERS))),
  );

  it.effect("gh's REST and GraphQL calls carry the token as a bearer token, bodies included", () =>
    Effect.gen(function* () {
      const caller = yield* attach(installation);
      yield* send("http://git.gw.test/api/v3/repos/acme/demo/pulls", {
        authorization: `token ${caller}`,
      });
      const json1 = jsonKey({
        query: "{ viewer { login } }",
      });
      const query = json1;
      yield* send(
        "http://git.gw.test/api/graphql",
        {
          authorization: `token ${caller}`,
          "content-type": "application/json",
          "content-length": `${query.length}`,
        },
        { method: "POST", body: query },
      );
      const [rest, graphql] = yield* sent;
      assert(rest !== undefined && graphql !== undefined);
      assert.strictEqual(rest.url, "https://api.github.com/repos/acme/demo/pulls");
      assert.deepStrictEqual(
        Headers.get(rest.headers, "authorization"),
        Option.some(`Bearer ${INSTALLATION_TOKEN}`),
      );
      assert.strictEqual(graphql.url, "https://api.github.com/graphql");
      assert.strictEqual(graphql.body, query);
    }).pipe(Effect.provide(gateway(NO_PROVIDERS))),
  );

  it.effect("an anonymous attachment forwards without any credential", () =>
    Effect.gen(function* () {
      const caller = yield* attach(AnonymousCredential.make());
      yield* send("http://git.gw.test/acme/demo.git/info/refs", {
        authorization: `Bearer ${caller}`,
      });
      const [request] = yield* sent;
      assert(request !== undefined);
      assert.isTrue(Option.isNone(Headers.get(request.headers, "authorization")));
    }).pipe(Effect.provide(gateway(NO_PROVIDERS))),
  );

  it.effect(
    "refuses without calling GitHub: other repository, no token, forged token, detached",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        const refusal = (response: { status: number; headers: globalThis.Headers }) => [
          response.status,
          response.headers.get(REFUSAL_HEADER),
        ];
        const currentResponse = yield* send("http://git.gw.test/acme/other.git/info/refs", {
          "x-usine-gateway-token": caller,
        });
        assert.deepStrictEqual(refusal(currentResponse), [403, "repository-mismatch"]);
        const nextResponse = yield* send(
          "http://git.gw.test/acme/other/releases/download/v1.0.0/tool.tar.gz",
          {
            "x-usine-gateway-token": caller,
          },
        );
        assert.deepStrictEqual(refusal(nextResponse), [403, "repository-mismatch"]);
        const updatedResponse = yield* send(
          "http://git.gw.test/api/v3/repos/acme/other/actions/artifacts/42/zip",
          {
            "x-usine-gateway-token": caller,
          },
        );
        assert.deepStrictEqual(refusal(updatedResponse), [403, "repository-mismatch"]);
        const latestResponse = yield* send("http://git.gw.test/acme/demo.git/info/refs", {});
        assert.deepStrictEqual(refusal(latestResponse), [401, "missing-caller-token"]);
        const secondResponse = yield* send("http://git.gw.test/acme/demo.git/info/refs", {
          authorization: "token ghp_stolen",
        });
        assert.deepStrictEqual(refusal(secondResponse), [401, "invalid-caller-token"]);
        const thirdResponse = yield* send("http://git.gw.test/acme/demo/settings", {
          "x-usine-gateway-token": caller,
        });
        assert.deepStrictEqual(refusal(thirdResponse), [404, "unsupported-path"]);
        yield* Effect.flatMap(Attachments, (attachments) => attachments.detach(ATTACHMENT));
        const fourthResponse = yield* send("http://git.gw.test/acme/demo.git/info/refs", {
          "x-usine-gateway-token": caller,
        });
        assert.deepStrictEqual(refusal(fourthResponse), [403, "stale-caller-token"]);
        const fifthResponse = yield* sent;
        assert.deepStrictEqual(fifthResponse, []);
      }).pipe(Effect.provide(gateway(NO_PROVIDERS))),
  );

  it.effect(
    "a token from a detached attachment stays refused after a fresh attach for the same Worker and repository",
    () =>
      Effect.gen(function* () {
        const earlier = yield* attach(installation);
        yield* Effect.flatMap(Attachments, (attachments) => attachments.detach(ATTACHMENT));
        const current = yield* attachAs(OTHER_ATTACHMENT, installation);
        const replayed = yield* send("http://git.gw.test/acme/demo.git/info/refs", {
          "x-usine-gateway-token": earlier,
        });
        assert.deepStrictEqual(
          [replayed.status, replayed.headers.get(REFUSAL_HEADER)],
          [403, "stale-caller-token"],
        );
        assert.include(replayed.body, ATTACHMENT);
        const fresh = yield* send("http://git.gw.test/acme/demo.git/info/refs", {
          "x-usine-gateway-token": current,
        });
        assert.strictEqual(fresh.status, 200);
        assert.strictEqual((yield* sent).length, 1);
      }).pipe(Effect.provide(gateway(NO_PROVIDERS))),
  );

  it.effect.each(["anthropic-messages", "anthropic"])(
    "%s requests replace the placeholder with the gateway API key",
    (prefix) =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        yield* send(
          `http://llm.gw.test/${prefix}/v1/messages?beta=true`,
          { "x-api-key": caller, "anthropic-version": "2023-06-01" },
          { method: "POST", body: "{}" },
        );
        const [request] = yield* sent;
        assert(request !== undefined);
        assert.strictEqual(request.url, "https://api.anthropic.com/v1/messages?beta=true");
        assert.strictEqual(
          lines.some((line) => line.includes("Deprecated LLM path prefix")),
          prefix === "anthropic",
        );
        for (const value of [caller, ANTHROPIC_KEY]) assert.notInclude(lines.join("\n"), value);
        assert.deepStrictEqual(
          Headers.get(request.headers, "x-api-key"),
          Option.some(ANTHROPIC_KEY),
        );
        assert.deepStrictEqual(
          Headers.get(request.headers, "anthropic-version"),
          Option.some("2023-06-01"),
        );
      }).pipe(
        Effect.provide(
          gateway({
            ...NO_PROVIDERS,
            "anthropic-messages": Option.some(
              AnthropicProvider.make({
                upstream: UpstreamBase.make("https://api.anthropic.com"),
                credential: AnthropicApiKey.make({ key: secret(ANTHROPIC_KEY) }),
              }),
            ),
          }),
        ),
      ),
  );

  it.effect(
    "a subscription token is sent as a bearer token with the OAuth beta flag merged in",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        yield* send("http://llm.gw.test/anthropic-messages/v1/messages", {
          authorization: `Bearer ${caller}`,
          "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
        });
        const [request] = yield* sent;
        assert(request !== undefined);
        assert.deepStrictEqual(
          Headers.get(request.headers, "authorization"),
          Option.some(`Bearer ${SUBSCRIPTION_TOKEN}`),
        );
        assert.deepStrictEqual(
          Headers.get(request.headers, "anthropic-beta"),
          Option.some("fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20"),
        );
      }).pipe(
        Effect.provide(
          gateway({
            ...NO_PROVIDERS,
            "anthropic-messages": Option.some(
              AnthropicProvider.make({
                upstream: UpstreamBase.make("https://api.anthropic.com"),
                credential: AnthropicSubscriptionToken.make({ token: secret(SUBSCRIPTION_TOKEN) }),
              }),
            ),
          }),
        ),
      ),
  );

  it.effect.each(["openai-responses", "openai"])(
    "%s requests replace the placeholder with a bearer key and refuse an unset provider",
    (prefix) =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        yield* send(`http://llm.gw.test/${prefix}/v1/responses`, {
          authorization: `Bearer ${caller}`,
        });
        const [request] = yield* sent;
        assert(request !== undefined);
        assert.strictEqual(request.url, "https://api.openai.com/v1/responses");
        assert.strictEqual(
          lines.some((line) => line.includes("Deprecated LLM path prefix")),
          prefix === "openai",
        );
        for (const value of [caller, OPENAI_KEY]) assert.notInclude(lines.join("\n"), value);
        assert.deepStrictEqual(
          Headers.get(request.headers, "authorization"),
          Option.some(`Bearer ${OPENAI_KEY}`),
        );
        const refused = yield* send("http://llm.gw.test/anthropic-messages/v1/messages", {
          "x-api-key": caller,
        });
        assert.deepStrictEqual(
          [refused.status, refused.headers.get(REFUSAL_HEADER)],
          [503, "provider-not-configured"],
        );
      }).pipe(
        Effect.provide(
          gateway({
            ...NO_PROVIDERS,
            "openai-responses": Option.some(
              OpenAiProvider.make({
                upstream: UpstreamBase.make("https://api.openai.com"),
                credential: OpenAiApiKey.make({ key: secret(OPENAI_KEY) }),
              }),
            ),
          }),
        ),
      ),
  );

  it.effect(
    "serves only the routes Claude Code and Codex call, and refuses other API routes, encoded separators, and dot segments before any upstream request",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        const ask = (path: string) =>
          send(
            `http://llm.gw.test${path}`,
            { authorization: `Bearer ${caller}` },
            { method: "POST", body: "{}" },
          );
        for (const path of [
          "/anthropic-messages/v1/messages?beta=true",
          "/anthropic-messages/v1/messages/count_tokens?beta=true",
          "/anthropic-messages/v1/models",
          "/anthropic-messages/v1/models/claude-haiku-5-5",
          "/openai-responses/v1/responses",
          "/openai-responses/v1/responses/compact",
          "/openai-responses/v1/models",
        ])
          assert.strictEqual((yield* ask(path)).status, 200, path);
        assert.deepStrictEqual(
          (yield* sent).map(({ url }) => url),
          [
            "https://api.anthropic.com/v1/messages?beta=true",
            "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
            "https://api.anthropic.com/v1/models",
            "https://api.anthropic.com/v1/models/claude-haiku-5-5",
            "https://api.openai.com/v1/responses",
            "https://api.openai.com/v1/responses/compact",
            "https://api.openai.com/v1/models",
          ],
        );

        for (const path of [
          // Other parts of the providers' APIs.
          "/anthropic-messages/v1/files",
          "/anthropic-messages/v1/messages/batches",
          "/anthropic-messages/v1/organizations/api_keys",
          "/openai-responses/v1/files",
          "/anthropic/v1/files",
          "/openai/v1/chat/completions",
          "/openai-responses/v1/chat/completions",
          // Paths outside /v1.
          "/anthropic-messages/messages",
          "/openai-responses/responses",
          "/openai-responses",
          // Percent-encoded separators.
          "/anthropic-messages/v1/messages%2F..%2F..%2Ffiles",
          "/openai-responses/v1/responses%2f..%2ffiles",
          "/openai-responses/v1/responses%5C..%5Cfiles",
          "/openai-responses/v1/responses%252F..%252Ffiles",
          // Dot segments, which URL parsing resolves before the route check.
          "/anthropic-messages/v1/messages/../files",
          "/openai-responses/v1/responses/%2e%2e/files",
          "/openai-responses/v1/responses/.%2E/files",
          "/anthropic-messages/v1/models/..",
          // Trailing and doubled separators.
          "/openai-responses/v1/responses/",
          "/anthropic-messages/v1//messages",
        ]) {
          const refused = yield* ask(path);
          assert.deepStrictEqual(
            [refused.status, refused.headers.get(REFUSAL_HEADER)],
            [404, "unsupported-path"],
            path,
          );
        }
        const response = yield* sent;
        assert.lengthOf(response, 7, "no refused path reached an upstream");
      }).pipe(
        Effect.provide(
          gateway({
            "anthropic-messages": Option.some(
              AnthropicProvider.make({
                upstream: UpstreamBase.make("https://api.anthropic.com"),
                credential: AnthropicApiKey.make({ key: secret(ANTHROPIC_KEY) }),
              }),
            ),
            "openai-responses": Option.some(
              OpenAiProvider.make({
                upstream: UpstreamBase.make("https://api.openai.com"),
                credential: OpenAiApiKey.make({ key: secret(OPENAI_KEY) }),
              }),
            ),
          }),
        ),
      ),
  );

  it.effect(
    "a release download streams the asset through the gateway and sends credentials only to GitHub",
    () =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        const response = yield* send(
          "http://git.gw.test/acme/demo/releases/download/v1.2.0/tool-linux-amd64.tar.gz",
          { "x-usine-gateway-token": caller },
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("location"), null);
        assert.strictEqual(response.body, "upstream body");
        assert.strictEqual(response.headers.get("x-upstream"), "yes");
        const requests = yield* sent;
        assert.deepStrictEqual(
          requests.map(({ url }) => url),
          [
            "https://github.com/acme/demo/releases/download/v1.2.0/tool-linux-amd64.tar.gz",
            ASSET_URL,
          ],
        );
        const [request] = requests;
        assert(request !== undefined);
        assert.deepStrictEqual(
          Headers.get(request.headers, "authorization"),
          Option.some(`Basic ${Base64.encode(`x-access-token:${INSTALLATION_TOKEN}`)}`),
        );
        assert.deepStrictEqual(requests[1]?.headers, Headers.empty);
        const served = lines.find((line) => line.includes("Served a GitHub release download"));
        assert(served !== undefined, lines.join("\n"));
        for (const field of ['"repository":"acme/demo"', '"status":200'])
          assert.include(served, field);
        assert.isTrue(
          lines.some((line) => line.includes('"target":"release-assets.githubusercontent.com"')),
        );
        for (const value of [caller, INSTALLATION_TOKEN, "signature-for-tests"])
          assert.isFalse(
            lines.some((line) => line.includes(value)),
            `a log line contains ${value.slice(0, 8)}`,
          );
      }).pipe(
        Effect.provide(
          gateway(
            NO_PROVIDERS,
            redirecting(302, {
              "https://github.com/acme/demo/releases/download/v1.2.0/tool-linux-amd64.tar.gz":
                ASSET_URL,
            }),
          ),
        ),
      ),
  );

  it.effect(
    "redirects to github.com and api.github.com point at git.<domain>, which serves a renamed repository's new name after GitHub's redirect",
    () =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        const location = (path: string) =>
          Effect.map(
            send(`http://git.gw.test${path}`, { "x-usine-gateway-token": caller }),
            (response) => [response.status, response.headers.get("location")],
          );
        const redirectLocation = yield* location("/api/v3/repos/acme/demo/pulls?state=open");
        assert.deepStrictEqual(redirectLocation, [
          301,
          "http://git.gw.test/api/v3/repositories/42/pulls?state=open",
        ]);
        const currentRedirectLocation = yield* location(
          "/acme/demo/releases/latest/download/tool.tar.gz",
        );
        assert.deepStrictEqual(currentRedirectLocation, [
          301,
          "http://git.gw.test/acme/demo/releases/download/v1.2.0/tool.tar.gz",
        ]);
        const nextRedirectLocation = yield* location(
          "/acme/demo.git/info/refs?service=git-upload-pack",
        );
        assert.deepStrictEqual(nextRedirectLocation, [
          301,
          "http://git.gw.test/acme/renamed.git/info/refs?service=git-upload-pack",
        ]);
        const updatedRedirectLocation = yield* location("/api/v3/repositories/42/pulls?state=open");
        assert.deepStrictEqual(updatedRedirectLocation, [200, null]);
        assert.strictEqual(
          (yield* sent).at(-1)?.url,
          "https://api.github.com/repositories/42/pulls?state=open",
        );
        const latestRedirectLocation = yield* location(
          "/acme/renamed.git/info/refs?service=git-upload-pack",
        );
        assert.deepStrictEqual(latestRedirectLocation, [200, null]);
        assert.strictEqual(
          (yield* sent).at(-1)?.url,
          "https://github.com/acme/renamed.git/info/refs?service=git-upload-pack",
        );
        const learned = lines.find((line) =>
          line.includes("Learned the new name of an attached repository"),
        );
        assert(learned !== undefined, lines.join("\n"));
        for (const field of [
          `"worker":"${WORKER}"`,
          '"repository":"acme/demo"',
          '"newName":"acme/renamed"',
        ])
          assert.include(learned, field);
        const rewrite = lines.find((line) => line.includes('"from":"api.github.com"'));
        assert(rewrite !== undefined, lines.join("\n"));
        for (const field of [
          "Rewrote a GitHub Location header to the gateway",
          '"repository":"acme/demo"',
          '"status":301',
          '"path":"/api/v3/repositories/42/pulls"',
        ])
          assert.include(rewrite, field);
      }).pipe(
        Effect.provide(
          gateway(
            NO_PROVIDERS,
            redirecting(
              301,
              {
                "https://api.github.com/repos/acme/demo/pulls?state=open":
                  "https://api.github.com/repositories/42/pulls?state=open",
                "https://github.com/acme/demo/releases/latest/download/tool.tar.gz":
                  "https://github.com/acme/demo/releases/download/v1.2.0/tool.tar.gz",
                "https://github.com/acme/demo.git/info/refs?service=git-upload-pack":
                  "https://github.com/acme/renamed.git/info/refs?service=git-upload-pack",
              },
              renamedRepository("acme/renamed"),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "only a permanent redirect of the repository itself to another name teaches a new name, and only to that attachment",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        const otherAttempt = yield* attachAs(OTHER_ATTACHMENT, installation);
        const outcome = (path: string, token: string) =>
          Effect.map(
            send(`http://git.gw.test${path}`, { "x-usine-gateway-token": token }),
            (response) => [response.status, response.headers.get(REFUSAL_HEADER)],
          );
        for (const path of [
          "/acme/demo.git/info/refs",
          "/acme/demo/info/refs",
          "/acme/demo/releases/download/v1.2.0/tool.tar.gz",
          "/api/v3/repositories/7",
        ])
          yield* outcome(path, caller);
        const responseOutcome = yield* outcome("/acme/renamed.git/info/refs", caller);
        assert.deepStrictEqual(responseOutcome, [200, null]);
        for (const [path, token] of [
          ["/acme/renamed.git/info/refs", otherAttempt],
          ["/acme/temporary/info/refs", caller],
          ["/acme/moved/releases/download/v1.2.0/tool.tar.gz", caller],
          ["/api/v3/repos/acme/elsewhere", caller],
        ] as const) {
          const currentResponseOutcome = yield* outcome(path, token);
          assert.deepStrictEqual(currentResponseOutcome, [403, "repository-mismatch"], path);
        }
      }).pipe(
        Effect.provide(
          gateway(
            NO_PROVIDERS,
            redirecting(
              301,
              {
                "https://github.com/acme/demo.git/info/refs":
                  "https://github.com/acme/renamed.git/info/refs",
                "https://github.com/acme/demo/releases/download/v1.2.0/tool.tar.gz":
                  "https://github.com/acme/moved/releases/download/v1.2.0/tool.tar.gz",
                "https://api.github.com/repositories/7":
                  "https://api.github.com/repos/acme/elsewhere",
              },
              redirecting(
                302,
                {
                  "https://github.com/acme/demo/info/refs":
                    "https://github.com/acme/temporary/info/refs",
                },
                renamedRepository("acme/renamed"),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "a rename teaches no name unless GitHub's API, called with the installation token, has the attached repository under that name",
    () =>
      Effect.forEach(
        [
          ["other-current-name", renamedRepository("acme/renamed")],
          ["former-name-not-redirected", ok],
        ] as const,
        ([reason, api]) =>
          Effect.gen(function* () {
            lines.length = 0;
            const caller = yield* attach(installation);
            const outcome = (path: string) =>
              Effect.map(
                send(`http://git.gw.test${path}`, { "x-usine-gateway-token": caller }),
                (response) => [response.status, response.headers.get(REFUSAL_HEADER)],
              );
            const responseOutcome = yield* outcome("/acme/demo.git/info/refs");
            assert.deepStrictEqual(responseOutcome, [301, null]);
            const currentResponseOutcome = yield* outcome("/acme/impostor.git/info/refs");
            assert.deepStrictEqual(currentResponseOutcome, [403, "repository-mismatch"], reason);
            const confirmation = (yield* sent).filter(({ url }) =>
              url.startsWith("https://api.github.com/"),
            );
            assert.isNotEmpty(confirmation, reason);
            for (const request of confirmation)
              assert.deepStrictEqual(
                Headers.get(request.headers, "authorization"),
                Option.some(`Bearer ${INSTALLATION_TOKEN}`),
              );
            const unconfirmed = lines.find((line) =>
              line.includes("GitHub's API didn't confirm the new name of an attached repository"),
            );
            assert(unconfirmed !== undefined, lines.join("\n"));
            for (const field of [`"reason":"${reason}"`, '"newName":"acme/impostor"'])
              assert.include(unconfirmed, field);
            for (const value of [caller, INSTALLATION_TOKEN])
              assert.isFalse(
                lines.some((line) => line.includes(value)),
                `a log line contains ${value.slice(0, 8)}`,
              );
          }).pipe(
            Effect.provide(
              gateway(
                NO_PROVIDERS,
                redirecting(
                  301,
                  {
                    "https://github.com/acme/demo.git/info/refs":
                      "https://github.com/acme/impostor.git/info/refs",
                  },
                  api,
                ),
              ),
            ),
          ),
        { discard: true },
      ),
  );

  it.effect(
    "the reverse proxy forwards nothing for other hosts, allowlisted ones included, and tells gh users how to download from an allowlisted one",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        const curl = "http://git.gw.test/OWNER/REPO/releases/download/TAG/FILE";
        for (const [url, hint] of [
          ["http://objects.githubusercontent.com/release/asset", true],
          ["http://example.com/", false],
        ] as const) {
          const refused = yield* send(url, { authorization: `token ${caller}` });
          assert.deepStrictEqual(
            [refused.status, refused.headers.get(REFUSAL_HEADER)],
            [404, "unknown-host"],
          );
          assert.strictEqual(refused.body.includes(curl), hint, refused.body);
        }
        const response = yield* sent;
        assert.deepStrictEqual(response, []);
      }).pipe(Effect.provide(gateway(NO_PROVIDERS))),
  );

  it.effect(
    "refusals are logged with the reason, Worker, and host, and no token reaches a log line",
    () =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        yield* send("http://git.gw.test/acme/demo.git/info/refs", {
          "x-usine-gateway-token": caller,
        });
        yield* send("http://git.gw.test/acme/other.git/info/refs", {
          "x-usine-gateway-token": caller,
        });
        yield* send("http://llm.gw.test/anthropic-messages/v1/messages", { "x-api-key": caller });
        const logged = [...lines];
        const refusal = logged.find((line) => line.includes("repository-mismatch"));
        assert(refusal !== undefined, logged.join("\n"));
        for (const field of [
          `"worker":"${WORKER}"`,
          '"host":"git.gw.test"',
          '"reason":"repository-mismatch"',
        ])
          assert.include(refusal, field);
        for (const value of [caller, INSTALLATION_TOKEN, ANTHROPIC_KEY])
          assert.isFalse(
            logged.some((line) => line.includes(value)),
            `a log line contains ${value.slice(0, 8)}`,
          );
      }).pipe(
        Effect.provide(
          gateway({
            ...NO_PROVIDERS,
            "anthropic-messages": Option.some(
              AnthropicProvider.make({
                upstream: UpstreamBase.make("https://api.anthropic.com"),
                credential: AnthropicApiKey.make({ key: secret(ANTHROPIC_KEY) }),
              }),
            ),
          }),
        ),
      ),
  );
});

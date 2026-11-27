import { jsonKey } from "@usine/core/json-key";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  Layer,
  Logger,
  Option,
  Redacted,
  Ref,
  Stream,
} from "effect";
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
  ApiKey,
  LlmProvider,
  AnthropicSubscriptionToken,
  type LlmProviders,
} from "../src/llm/llm.ts";
import { GatewayProxy, REFUSAL_HEADER } from "../src/proxy/proxy.ts";
import { llmProviders } from "../src/node/environment.ts";
import {
  anthropic,
  ApiKeyCredential,
  GatewaySlot,
  GatewayVariable,
  HeaderName,
  KeyHeader,
  ModelProvider,
  ModelProviderCatalog,
  ModelProviderId,
  modelProviders,
  openai,
  opencodeGo,
  ProviderProtocol,
  RoutePattern,
  UpstreamBase,
  WireProtocol,
} from "@usine/core/agent/provider";
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

const PLAN_KEY = "plan-key-for-tests-0123456789";

/**
 * A provider that only this test defines: one static key for two protocols, which take the key
 * in different headers, and one header that passes to the upstream.
 */
const plan = ModelProvider.make({
  id: ModelProviderId.make("test-plan"),
  slot: GatewaySlot.make("test-plan"),
  label: "Test plan",
  protocols: [
    ProviderProtocol.make({
      protocol: WireProtocol.make("openai-chat-completions"),
      upstream: UpstreamBase.make("https://plan.test/openai/v1"),
      routes: [RoutePattern.make("/chat/completions")],
      key: KeyHeader.make({ header: HeaderName.make("authorization"), scheme: "bearer" }),
    }),
    ProviderProtocol.make({
      protocol: WireProtocol.make("google-generate-content"),
      upstream: UpstreamBase.make("https://plan.test/google/v1beta"),
      routes: [RoutePattern.make("/models/{model}:streamGenerateContent")],
      key: KeyHeader.make({ header: HeaderName.make("x-goog-api-key"), scheme: "none" }),
    }),
  ],
  credentials: [ApiKeyCredential.make({ variable: GatewayVariable.make("TEST_PLAN_API_KEY") })],
  passThrough: Option.some([HeaderName.make("x-plan-session")]),
});

const withPlan = ModelProviderCatalog.make({ providers: [...modelProviders.providers, plan] });

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

const gateway = (
  providers: LlmProviders,
  answer: Answer = ok,
  catalog: ModelProviderCatalog = modelProviders,
) =>
  GatewayProxy.layer.pipe(
    Layer.provideMerge(gatewayServices),
    Layer.provide(fakeClient),
    Layer.provideMerge(Upstream.answering(answer)),
    Layer.provideMerge(settingsLayer(providers, undefined, undefined, catalog)),
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
    "refuses without calling GitHub: other repository, no token, forged token, detached, and logs each refusal without a token",
    () =>
      Effect.gen(function* () {
        lines.length = 0;
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
        const mismatch = lines.find((line) => line.includes("repository-mismatch"));
        assert(mismatch !== undefined, lines.join("\n"));
        for (const field of [
          `"worker":"${WORKER}"`,
          '"host":"git.gw.test"',
          '"reason":"repository-mismatch"',
        ])
          assert.include(mismatch, field);
        for (const value of [caller, INSTALLATION_TOKEN, "ghp_stolen"])
          assert.isFalse(
            lines.some((line) => line.includes(value)),
            `a log line contains ${value.slice(0, 8)}`,
          );
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

  it.effect(
    "anthropic-messages requests replace the placeholder with the gateway API key, and the deprecated anthropic prefix still works",
    () =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        yield* send(
          "http://llm.gw.test/anthropic-messages/v1/messages?beta=true",
          { "x-api-key": caller, "anthropic-version": "2023-06-01" },
          { method: "POST", body: "{}" },
        );
        const [request] = yield* sent;
        assert(request !== undefined);
        assert.strictEqual(request.url, "https://api.anthropic.com/v1/messages?beta=true");
        assert.isFalse(lines.some((line) => line.includes("Deprecated LLM path prefix")));
        assert.deepStrictEqual(
          Headers.get(request.headers, "x-api-key"),
          Option.some(ANTHROPIC_KEY),
        );
        assert.deepStrictEqual(
          Headers.get(request.headers, "anthropic-version"),
          Option.some("2023-06-01"),
        );
        yield* send(
          "http://llm.gw.test/anthropic/v1/messages",
          { "x-api-key": caller },
          { method: "POST", body: "{}" },
        );
        assert.strictEqual((yield* sent)[1]?.url, "https://api.anthropic.com/v1/messages");
        assert.isTrue(lines.some((line) => line.includes("Deprecated LLM path prefix")));
        for (const value of [caller, ANTHROPIC_KEY]) assert.notInclude(lines.join("\n"), value);
      }).pipe(
        Effect.provide(
          gateway({
            [anthropic.slot]: LlmProvider.make({
              upstream: Option.some(UpstreamBase.make("https://api.anthropic.com")),
              credential: ApiKey.make({ key: secret(ANTHROPIC_KEY) }),
            }),
          }),
        ),
      ),
  );

  it.effect(
    "a subscription token is sent as a bearer token with the OAuth beta flag merged in",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        yield* send(
          "http://llm.gw.test/anthropic-messages/v1/messages",
          {
            authorization: `Bearer ${caller}`,
            "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
          },
          { method: "POST", body: "{}" },
        );
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
            [anthropic.slot]: LlmProvider.make({
              upstream: Option.some(UpstreamBase.make("https://api.anthropic.com")),
              credential: AnthropicSubscriptionToken.make({ token: secret(SUBSCRIPTION_TOKEN) }),
            }),
          }),
        ),
      ),
  );

  it.effect(
    "openai-responses requests replace the placeholder with a bearer key, the deprecated openai prefix still works, and an unset provider is refused",
    () =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        yield* send(
          "http://llm.gw.test/openai-responses/v1/responses",
          { authorization: `Bearer ${caller}` },
          { method: "POST", body: "{}" },
        );
        const [request] = yield* sent;
        assert(request !== undefined);
        assert.strictEqual(request.url, "https://api.openai.com/v1/responses");
        assert.isFalse(lines.some((line) => line.includes("Deprecated LLM path prefix")));
        assert.deepStrictEqual(
          Headers.get(request.headers, "authorization"),
          Option.some(`Bearer ${OPENAI_KEY}`),
        );
        yield* send(
          "http://llm.gw.test/openai/v1/responses",
          { authorization: `Bearer ${caller}` },
          { method: "POST", body: "{}" },
        );
        assert.strictEqual((yield* sent)[1]?.url, "https://api.openai.com/v1/responses");
        assert.isTrue(lines.some((line) => line.includes("Deprecated LLM path prefix")));
        for (const value of [caller, OPENAI_KEY]) assert.notInclude(lines.join("\n"), value);
        const refused = yield* send(
          "http://llm.gw.test/anthropic-messages/v1/messages",
          { "x-api-key": caller },
          { method: "POST", body: "{}" },
        );
        assert.deepStrictEqual(
          [refused.status, refused.headers.get(REFUSAL_HEADER)],
          [503, "provider-not-configured"],
        );
      }).pipe(
        Effect.provide(
          gateway({
            [openai.slot]: LlmProvider.make({
              upstream: Option.some(UpstreamBase.make("https://api.openai.com")),
              credential: ApiKey.make({ key: secret(OPENAI_KEY) }),
            }),
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
        const list = (path: string) =>
          send(`http://llm.gw.test${path}`, { authorization: `Bearer ${caller}` });
        for (const [path, request] of [
          ["/anthropic-messages/v1/messages?beta=true", ask],
          ["/anthropic-messages/v1/messages/count_tokens?beta=true", ask],
          ["/anthropic-messages/v1/models", list],
          ["/anthropic-messages/v1/models/claude-haiku-5-5", list],
          ["/openai-responses/v1/responses", ask],
          ["/openai-responses/v1/responses/compact", ask],
          ["/openai-responses/v1/models", list],
        ] as const)
          assert.strictEqual((yield* request(path)).status, 200, path);
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
            [anthropic.slot]: LlmProvider.make({
              upstream: Option.some(UpstreamBase.make("https://api.anthropic.com")),
              credential: ApiKey.make({ key: secret(ANTHROPIC_KEY) }),
            }),
            [openai.slot]: LlmProvider.make({
              upstream: Option.some(UpstreamBase.make("https://api.openai.com")),
              credential: ApiKey.make({ key: secret(OPENAI_KEY) }),
            }),
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
});

describe("a provider slot that the catalog declares", () => {
  /** The plan's credential as the gateway reads it from its environment, which sets only the entry's variable. */
  const planProviders = (catalog: ModelProviderCatalog) =>
    llmProviders(catalog).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ TEST_PLAN_API_KEY: PLAN_KEY }),
      ),
      Effect.provide([NodeFileSystem.layer, NodeCrypto.layer]),
      Effect.orDie,
    );

  it.effect(
    "sends the key in the header of each protocol, passes the listed header, refuses other routes, and returns error bodies unchanged",
    () =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        const chat = yield* send(
          "http://llm.gw.test/test-plan/chat/completions",
          {
            authorization: `Bearer ${caller}`,
            "content-type": "application/json",
            "x-plan-session": "session-1",
            "x-repository-hash": "a1b2c3",
          },
          { method: "POST", body: '{"model":"plan-model"}' },
        );
        assert.strictEqual(chat.status, 200);
        const streamed = yield* send(
          "http://llm.gw.test/test-plan/models/plan-model-2.5:streamGenerateContent?alt=sse",
          { "x-goog-api-key": caller, "x-plan-session": "session-1" },
          { method: "POST", body: "{}" },
        );
        assert.strictEqual(streamed.status, 429);
        assert.strictEqual(streamed.body, '{"error":{"code":"plan_limit_reached"}}');
        const [toChat, toGoogle] = yield* sent;
        assert(toChat !== undefined && toGoogle !== undefined);
        assert.strictEqual(toChat.url, "https://plan.test/openai/v1/chat/completions");
        assert.deepStrictEqual(
          [
            Headers.get(toChat.headers, "authorization"),
            Headers.get(toChat.headers, "x-plan-session"),
            Headers.get(toChat.headers, "content-type"),
            Headers.get(toChat.headers, "x-repository-hash"),
          ],
          [
            Option.some(`Bearer ${PLAN_KEY}`),
            Option.some("session-1"),
            Option.some("application/json"),
            Option.none(),
          ],
        );
        assert.strictEqual(
          toGoogle.url,
          "https://plan.test/google/v1beta/models/plan-model-2.5:streamGenerateContent?alt=sse",
        );
        assert.deepStrictEqual(
          [
            Headers.get(toGoogle.headers, "x-goog-api-key"),
            Headers.get(toGoogle.headers, "authorization"),
          ],
          [Option.some(PLAN_KEY), Option.none()],
        );

        for (const path of [
          "/test-plan/v1/chat/completions",
          "/test-plan/files",
          "/test-plan/models/plan-model:generateContent",
          "/test-plan/models/..:streamGenerateContent",
        ]) {
          const refused = yield* send(
            `http://llm.gw.test${path}`,
            { authorization: `Bearer ${caller}` },
            { method: "POST", body: "{}" },
          );
          assert.deepStrictEqual(
            [refused.status, refused.headers.get(REFUSAL_HEADER)],
            [404, "unsupported-path"],
            path,
          );
        }
        const forwarded = yield* sent;
        assert.lengthOf(forwarded, 2, "no refused route reached an upstream");
        const logged = lines.join("\n");
        assert.include(logged, '"provider":"test-plan"');
        for (const value of [caller, PLAN_KEY]) assert.notInclude(logged, value);
      }).pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.map(planProviders(withPlan), (providers) =>
              gateway(
                providers,
                (url) =>
                  url.pathname.includes(":streamGenerateContent")
                    ? new Response('{"error":{"code":"plan_limit_reached"}}', {
                        status: 429,
                        headers: { "content-type": "application/json" },
                      })
                    : ok(url),
                withPlan,
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "removes a caller token from each protocol's key header for an entry without a pass-through list",
    () => {
      const open = ModelProvider.make({ ...plan, passThrough: Option.none() });
      const withOpenPlan = ModelProviderCatalog.make({
        providers: [...modelProviders.providers, open],
      });
      return Effect.gen(function* () {
        const caller = yield* attach(installation);
        const chat = yield* send(
          "http://llm.gw.test/test-plan/chat/completions",
          {
            authorization: `Bearer ${caller}`,
            "x-goog-api-key": caller,
            "x-plan-session": "session-1",
          },
          { method: "POST", body: '{"model":"plan-model"}' },
        );
        assert.strictEqual(chat.status, 200);
        const [toChat] = yield* sent;
        assert(toChat !== undefined);
        assert.deepStrictEqual(
          [
            Headers.get(toChat.headers, "authorization"),
            Headers.get(toChat.headers, "x-goog-api-key"),
            Headers.get(toChat.headers, "x-plan-session"),
          ],
          [Option.some(`Bearer ${PLAN_KEY}`), Option.none(), Option.some("session-1")],
        );
      }).pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.map(planProviders(withOpenPlan), (providers) =>
              gateway(providers, ok, withOpenPlan),
            ),
          ),
        ),
      );
    },
  );

  it.effect("refuses the slot while the gateway has no key for it", () =>
    Effect.gen(function* () {
      const caller = yield* attach(installation);
      const refused = yield* send("http://llm.gw.test/test-plan/chat/completions", {
        authorization: `Bearer ${caller}`,
      });
      assert.deepStrictEqual(
        [refused.status, refused.headers.get(REFUSAL_HEADER)],
        [503, "provider-not-configured"],
      );
      const forwarded = yield* sent;
      assert.deepStrictEqual(forwarded, []);
    }).pipe(Effect.provide(gateway(NO_PROVIDERS, ok, withPlan))),
  );
});

describe("the OpenCode Go slot", () => {
  const GO_KEY = "go-key-for-tests-0123456789";
  const OVERRIDE = "https://openai-override.test";
  /**
   * The gateway's credentials as it reads them from an environment with a key for OpenCode Go, and
   * an OpenAI key whose upstream variable is set.
   */
  const keyedProviders = llmProviders(modelProviders).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        OPENCODE_GO_API_KEY: GO_KEY,
        OPENAI_API_KEY: OPENAI_KEY,
        USINE_GATEWAY_OPENAI_UPSTREAM: OVERRIDE,
      }),
    ),
    Effect.provide([NodeFileSystem.layer, NodeCrypto.layer]),
    Effect.orDie,
  );
  /** The body of the plan's usage limit, which OpenCode reads by its code. */
  const LIMIT = '{"type":"error","error":{"type":"GoUsageLimitError","message":"limit"}}';

  it.effect(
    "sends the key to each protocol's upstream in its header, passes OpenCode's headers, and returns a limit's body unchanged",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        const session = {
          "x-opencode-session-id": "ses_1",
          "x-opencode-session": "ses_1",
          "x-session-affinity": "ses_1",
          "x-session-id": "ses_1",
          "x-opencode-project": "a1b2c3",
          "x-opencode-client": "cli",
          "x-repository-hash": "d4e5f6",
          "content-type": "application/json",
        };
        const answers = yield* Effect.forEach(
          [
            ["/chat/completions", { authorization: `Bearer ${caller}` }],
            ["/responses", { authorization: `Bearer ${caller}` }],
            [
              "/messages",
              {
                "x-api-key": caller,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "interleaved-thinking-2025-05-14",
              },
            ],
            ["/models/gemini-4-argon:streamGenerateContent?alt=sse", { "x-goog-api-key": caller }],
          ] as const,
          ([path, key]) =>
            send(
              `http://llm.gw.test/${opencodeGo.slot}${path}`,
              { ...session, ...key },
              { method: "POST", body: '{"model":"go-model"}' },
            ),
        );
        assert.deepStrictEqual(
          answers.map(({ status, body }) => [status, body]),
          [
            [200, "upstream body"],
            [200, "upstream body"],
            [429, LIMIT],
            [200, "upstream body"],
          ],
        );
        const forwarded = yield* sent;
        assert.deepStrictEqual(
          forwarded.map(({ url, headers }) => [
            url,
            Headers.get(headers, "authorization"),
            Headers.get(headers, "x-api-key"),
            Headers.get(headers, "x-goog-api-key"),
          ]),
          [
            [
              "https://opencode.ai/inference/go/openai/v1/chat/completions",
              Option.some(`Bearer ${GO_KEY}`),
              Option.none(),
              Option.none(),
            ],
            [
              "https://opencode.ai/inference/go/openai/v1/responses",
              Option.some(`Bearer ${GO_KEY}`),
              Option.none(),
              Option.none(),
            ],
            [
              "https://opencode.ai/inference/go/anthropic/v1/messages",
              Option.none(),
              Option.some(GO_KEY),
              Option.none(),
            ],
            [
              "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse",
              Option.none(),
              Option.none(),
              Option.some(GO_KEY),
            ],
          ],
        );
        for (const { headers } of forwarded) {
          for (const [name, value] of Object.entries(session))
            assert.deepStrictEqual(
              Headers.get(headers, name),
              name === "x-repository-hash" ? Option.none() : Option.some(value),
              name,
            );
        }
        const messages = forwarded[2];
        assert(messages !== undefined);
        assert.deepStrictEqual(
          [
            Headers.get(messages.headers, "anthropic-version"),
            Headers.get(messages.headers, "anthropic-beta"),
          ],
          [Option.some("2023-06-01"), Option.some("interleaved-thinking-2025-05-14")],
        );
        assert.isFalse(forwarded.some(({ url }) => url.startsWith(OVERRIDE)));
        assert.notInclude(lines.join("\n"), GO_KEY);
      }).pipe(
        Effect.provide(
          Layer.unwrap(
            Effect.map(keyedProviders, (providers) => {
              assert.deepStrictEqual(
                Object.keys(providers).sort(),
                [openai.slot, opencodeGo.slot].sort(),
                "the gateway holds both keys",
              );
              return gateway(providers, (url) =>
                url.pathname.endsWith("/messages")
                  ? new Response(LIMIT, {
                      status: 429,
                      headers: { "content-type": "application/json" },
                    })
                  : ok(url),
              );
            }),
          ),
        ),
      ),
  );

  it.effect(
    "leaves a caller token sent as ?key= out of the upstream URL, and refuses a method that the route doesn't list",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        const stream = yield* send(
          `http://llm.gw.test/${opencodeGo.slot}/models/gemini-4-argon:streamGenerateContent?alt=sse&key=${caller}`,
          { "x-goog-api-key": caller },
          { method: "POST", body: '{"model":"go-model"}' },
        );
        const listing = yield* send(`http://llm.gw.test/${opencodeGo.slot}/chat/completions`, {
          authorization: `Bearer ${caller}`,
        });

        assert.deepStrictEqual(
          [stream.status, listing.status, listing.headers.get(REFUSAL_HEADER)],
          [200, 404, "unsupported-path"],
        );
        const forwarded = yield* sent;
        assert.deepStrictEqual(
          forwarded.map(({ url, headers }) => [url, Headers.get(headers, "x-goog-api-key")]),
          [
            [
              "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse",
              Option.some(GO_KEY),
            ],
          ],
        );
        assert.include(
          lines.find(
            (line) =>
              line.includes("Gateway refused a request") &&
              line.includes(`"path":"/${opencodeGo.slot}/chat/completions"`),
          ),
          '"method":"GET"',
        );
      }).pipe(
        Effect.provide(
          Layer.unwrap(Effect.map(keyedProviders, (providers) => gateway(providers, ok))),
        ),
      ),
  );
});

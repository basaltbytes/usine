import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Effect,
  Encoding,
  Layer,
  Logger,
  Option,
  Redacted,
  Ref,
  Stream,
} from "effect";
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
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

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers.Headers;
  readonly body: string;
}

/** The requests the fake upstream received. */
class Upstream extends Context.Service<Upstream, { readonly sent: Ref.Ref<ReadonlyArray<Sent>> }>()(
  "test/Upstream",
) {
  static readonly layer = Layer.effect(
    Upstream,
    Effect.map(Ref.make<ReadonlyArray<Sent>>([]), (sent) => ({ sent })),
  );
}

const fakeClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const { sent } = yield* Upstream;
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
        return HttpClientResponse.fromWeb(
          request,
          new Response("upstream body", { status: 200, headers: { "x-upstream": "yes" } }),
        );
      }),
    );
  }),
);

const lines: Array<string> = [];
const captureLogs = Logger.layer([
  Logger.make(({ message }) => {
    lines.push(JSON.stringify(message));
  }),
]);

const gateway = (providers: LlmProviders) =>
  GatewayProxy.layer.pipe(
    Layer.provideMerge(gatewayServices),
    Layer.provide(fakeClient),
    Layer.provideMerge(Upstream.layer),
    Layer.provideMerge(settingsLayer(providers)),
    Layer.provideMerge(captureLogs),
  );

/** Attaches `credential` for the test Worker and repository under `id` and returns the caller token. */
const attachAs = (id: AttachmentId, credential: AttachmentCredential) =>
  Effect.gen(function* () {
    const attachments = yield* Attachments;
    const callers = yield* CallerTokens;
    yield* attachments.attach(
      new Attachment({
        id,
        worker: WORKER,
        repository: REPOSITORY,
        credential,
        expiresAt: DateTime.add(yield* DateTime.now, { hours: 1 }),
      }),
    );
    return Redacted.value(
      yield* callers.issue(
        new CallerClaims({ attachment: id, worker: WORKER, repository: REPOSITORY }),
      ),
    );
  });

const attach = (credential: AttachmentCredential) => attachAs(ATTACHMENT, credential);

const installation = new InstallationCredential({ token: secret(INSTALLATION_TOKEN) });

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
          Option.some(`Basic ${Encoding.encodeBase64(`x-access-token:${INSTALLATION_TOKEN}`)}`),
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
      const query = JSON.stringify({ query: "{ viewer { login } }" });
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
      const caller = yield* attach(new AnonymousCredential());
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
        assert.deepStrictEqual(
          refusal(
            yield* send("http://git.gw.test/acme/other.git/info/refs", {
              "x-usine-gateway-token": caller,
            }),
          ),
          [403, "repository-mismatch"],
        );
        assert.deepStrictEqual(
          refusal(yield* send("http://git.gw.test/acme/demo.git/info/refs", {})),
          [401, "missing-caller-token"],
        );
        assert.deepStrictEqual(
          refusal(
            yield* send("http://git.gw.test/acme/demo.git/info/refs", {
              authorization: "token ghp_stolen",
            }),
          ),
          [401, "invalid-caller-token"],
        );
        assert.deepStrictEqual(
          refusal(
            yield* send("http://git.gw.test/acme/demo/settings", {
              "x-usine-gateway-token": caller,
            }),
          ),
          [404, "unsupported-path"],
        );
        yield* Effect.flatMap(Attachments, (attachments) => attachments.detach(ATTACHMENT));
        assert.deepStrictEqual(
          refusal(
            yield* send("http://git.gw.test/acme/demo.git/info/refs", {
              "x-usine-gateway-token": caller,
            }),
          ),
          [403, "stale-caller-token"],
        );
        assert.deepStrictEqual(yield* sent, []);
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

  it.effect("Anthropic requests carry the gateway's API key in place of the placeholder", () =>
    Effect.gen(function* () {
      const caller = yield* attach(installation);
      yield* send(
        "http://llm.gw.test/anthropic/v1/messages?beta=true",
        { "x-api-key": caller, "anthropic-version": "2023-06-01" },
        { method: "POST", body: "{}" },
      );
      const [request] = yield* sent;
      assert(request !== undefined);
      assert.strictEqual(request.url, "https://api.anthropic.com/v1/messages?beta=true");
      assert.deepStrictEqual(Headers.get(request.headers, "x-api-key"), Option.some(ANTHROPIC_KEY));
      assert.deepStrictEqual(
        Headers.get(request.headers, "anthropic-version"),
        Option.some("2023-06-01"),
      );
    }).pipe(
      Effect.provide(
        gateway({
          ...NO_PROVIDERS,
          anthropic: Option.some(
            new AnthropicProvider({
              upstream: UpstreamBase.make("https://api.anthropic.com"),
              credential: new AnthropicApiKey({ key: secret(ANTHROPIC_KEY) }),
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
        yield* send("http://llm.gw.test/anthropic/v1/messages", {
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
            anthropic: Option.some(
              new AnthropicProvider({
                upstream: UpstreamBase.make("https://api.anthropic.com"),
                credential: new AnthropicSubscriptionToken({ token: secret(SUBSCRIPTION_TOKEN) }),
              }),
            ),
          }),
        ),
      ),
  );

  it.effect(
    "Codex's OpenAI requests carry the key as a bearer token; an unset provider is refused",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        yield* send("http://llm.gw.test/openai/v1/responses", {
          authorization: `Bearer ${caller}`,
        });
        const [request] = yield* sent;
        assert(request !== undefined);
        assert.strictEqual(request.url, "https://api.openai.com/v1/responses");
        assert.deepStrictEqual(
          Headers.get(request.headers, "authorization"),
          Option.some(`Bearer ${OPENAI_KEY}`),
        );
        const refused = yield* send("http://llm.gw.test/anthropic/v1/messages", {
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
            openai: Option.some(
              new OpenAiProvider({
                upstream: UpstreamBase.make("https://api.openai.com"),
                key: secret(OPENAI_KEY),
              }),
            ),
          }),
        ),
      ),
  );

  it.effect("the reverse proxy forwards nothing for other hosts, allowlisted ones included", () =>
    Effect.gen(function* () {
      const caller = yield* attach(installation);
      for (const url of [
        "http://objects.githubusercontent.com/release/asset",
        "http://example.com/",
      ]) {
        const refused = yield* send(url, { authorization: `token ${caller}` });
        assert.deepStrictEqual(
          [refused.status, refused.headers.get(REFUSAL_HEADER)],
          [404, "unknown-host"],
        );
      }
      assert.deepStrictEqual(yield* sent, []);
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
        yield* send("http://llm.gw.test/anthropic/v1/messages", { "x-api-key": caller });
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
            anthropic: Option.some(
              new AnthropicProvider({
                upstream: UpstreamBase.make("https://api.anthropic.com"),
                credential: new AnthropicApiKey({ key: secret(ANTHROPIC_KEY) }),
              }),
            ),
          }),
        ),
      ),
  );
});

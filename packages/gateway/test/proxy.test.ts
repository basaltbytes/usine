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

/** The requests the fake upstream received, and its answer to each. */
class Upstream extends Context.Service<
  Upstream,
  { readonly sent: Ref.Ref<ReadonlyArray<Sent>>; readonly answer: Answer }
>()("test/Upstream") {
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
    lines.push(JSON.stringify(message));
  }),
]);

const gateway = (providers: LlmProviders, answer: Answer = ok) =>
  GatewayProxy.layer.pipe(
    Layer.provideMerge(gatewayServices),
    Layer.provide(fakeClient),
    Layer.provideMerge(Upstream.answering(answer)),
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
          refusal(
            yield* send("http://git.gw.test/acme/other/releases/download/v1.0.0/tool.tar.gz", {
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

  it.effect(
    "a release download sends the installation token to github.com only, and passes its redirect to the asset host back unchanged",
    () =>
      Effect.gen(function* () {
        lines.length = 0;
        const caller = yield* attach(installation);
        const response = yield* send(
          "http://git.gw.test/acme/demo/releases/download/v1.2.0/tool-linux-amd64.tar.gz",
          { "x-usine-gateway-token": caller },
        );
        assert.strictEqual(response.status, 302);
        assert.strictEqual(response.headers.get("location"), ASSET_URL);
        const requests = yield* sent;
        assert.deepStrictEqual(
          requests.map(({ url }) => url),
          ["https://github.com/acme/demo/releases/download/v1.2.0/tool-linux-amd64.tar.gz"],
        );
        const [request] = requests;
        assert(request !== undefined);
        assert.deepStrictEqual(
          Headers.get(request.headers, "authorization"),
          Option.some(`Basic ${Encoding.encodeBase64(`x-access-token:${INSTALLATION_TOKEN}`)}`),
        );
        const served = lines.find((line) => line.includes("Served a GitHub release download"));
        assert(served !== undefined, lines.join("\n"));
        for (const field of [
          '"repository":"acme/demo"',
          '"status":302',
          '"target":"release-assets.githubusercontent.com"',
        ])
          assert.include(served, field);
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
        assert.deepStrictEqual(yield* location("/api/v3/repos/acme/demo/pulls?state=open"), [
          301,
          "http://git.gw.test/api/v3/repositories/42/pulls?state=open",
        ]);
        assert.deepStrictEqual(yield* location("/acme/demo/releases/latest/download/tool.tar.gz"), [
          301,
          "http://git.gw.test/acme/demo/releases/download/v1.2.0/tool.tar.gz",
        ]);
        assert.deepStrictEqual(
          yield* location("/acme/demo.git/info/refs?service=git-upload-pack"),
          [301, "http://git.gw.test/acme/renamed.git/info/refs?service=git-upload-pack"],
        );
        assert.deepStrictEqual(yield* location("/api/v3/repositories/42/pulls?state=open"), [
          200,
          null,
        ]);
        assert.strictEqual(
          (yield* sent).at(-1)?.url,
          "https://api.github.com/repositories/42/pulls?state=open",
        );
        assert.deepStrictEqual(
          yield* location("/acme/renamed.git/info/refs?service=git-upload-pack"),
          [200, null],
        );
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
            redirecting(301, {
              "https://api.github.com/repos/acme/demo/pulls?state=open":
                "https://api.github.com/repositories/42/pulls?state=open",
              "https://github.com/acme/demo/releases/latest/download/tool.tar.gz":
                "https://github.com/acme/demo/releases/download/v1.2.0/tool.tar.gz",
              "https://github.com/acme/demo.git/info/refs?service=git-upload-pack":
                "https://github.com/acme/renamed.git/info/refs?service=git-upload-pack",
            }),
          ),
        ),
      ),
  );

  it.effect(
    "only a permanent redirect of a request that names the repository teaches a new name, and only to that attachment",
    () =>
      Effect.gen(function* () {
        const caller = yield* attach(installation);
        const otherAttempt = yield* attachAs(OTHER_ATTACHMENT, installation);
        const outcome = (path: string, token: string) =>
          Effect.map(
            send(`http://git.gw.test${path}`, { "x-usine-gateway-token": token }),
            (response) => [response.status, response.headers.get(REFUSAL_HEADER)],
          );
        yield* outcome("/acme/demo.git/info/refs", caller);
        yield* outcome("/acme/demo/releases/download/v1.2.0/tool.tar.gz", caller);
        yield* outcome("/api/v3/repositories/42", caller);
        assert.deepStrictEqual(yield* outcome("/acme/renamed.git/info/refs", caller), [200, null]);
        for (const [path, token] of [
          ["/acme/renamed.git/info/refs", otherAttempt],
          ["/acme/moved/releases/download/v1.2.0/tool.tar.gz", caller],
          ["/api/v3/repos/acme/elsewhere", caller],
        ] as const)
          assert.deepStrictEqual(yield* outcome(path, token), [403, "repository-mismatch"], path);
      }).pipe(
        Effect.provide(
          gateway(
            NO_PROVIDERS,
            redirecting(
              301,
              {
                "https://github.com/acme/demo.git/info/refs":
                  "https://github.com/acme/renamed.git/info/refs",
                "https://api.github.com/repositories/42":
                  "https://api.github.com/repos/acme/elsewhere",
              },
              redirecting(302, {
                "https://github.com/acme/demo/releases/download/v1.2.0/tool.tar.gz":
                  "https://github.com/acme/moved/releases/download/v1.2.0/tool.tar.gz",
              }),
            ),
          ),
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

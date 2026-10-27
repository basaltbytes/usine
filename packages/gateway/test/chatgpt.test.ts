import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Deferred,
  type Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import {
  Headers,
  HttpClient,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { AnonymousCredential, Attachment } from "../src/attachment/attachment.ts";
import { Attachments } from "../src/attachment/store.ts";
import { CallerClaims, CallerTokens } from "../src/caller/caller.ts";
import { checkAuthFileWritable } from "../src/chatgpt/auth-file.ts";
import { ChatGptLogins } from "../src/chatgpt/logins.ts";
import { gatewayServices } from "../src/gateway.ts";
import { ChatGptLogin, HostFilePath, type LlmProviders, OpenAiProvider } from "../src/llm/llm.ts";
import { GatewayAddresses, gatewayLayer } from "../src/node/node.ts";
import { GatewayProxy, REFUSAL_HEADER } from "../src/proxy/proxy.ts";
import { UpstreamBase } from "../src/upstream.ts";
import {
  ATTACHMENT,
  CHATGPT_ACCOUNT,
  NO_PROVIDERS,
  REPOSITORY,
  WORKER,
  authFileText,
  chatGptAccessToken,
  fakeJwt,
  nonceOf,
  settingsLayer,
} from "./fixtures.ts";

const TOKEN_URL = "https://auth.test/oauth/token";
const BACKEND = "https://chatgpt.test/backend-api/codex";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers.Headers;
  readonly body: string;
}

/** The fake token endpoint's and ChatGPT backend's answer to a request. */
type Answer = (sent: Sent) => Effect.Effect<Response>;

/** The requests the fake upstreams received, and the answer they give, which a test can change. */
class Upstreams extends Context.Service<
  Upstreams,
  { readonly sent: Ref.Ref<ReadonlyArray<Sent>>; readonly answer: Ref.Ref<Answer> }
>()("test/ChatGptUpstreams") {
  static readonly layer = Layer.effect(
    Upstreams,
    Effect.all({
      sent: Ref.make<ReadonlyArray<Sent>>([]),
      answer: Ref.make<Answer>(() => Effect.succeed(json(500, { error: "no answer set" }))),
    }),
  );
}

const json = (status: number, body: Schema.Json) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const decoder = new TextDecoder();

const fakeClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const { sent, answer } = yield* Upstreams;
    return HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Stream"
            ? yield* request.body.stream.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie)
            : request.body._tag === "Uint8Array"
              ? decoder.decode(request.body.body)
              : "";
        const received = {
          method: request.method,
          url: url.toString(),
          headers: request.headers,
          body,
        };
        yield* Ref.update(sent, (all) => [...all, received]);
        return HttpClientResponse.fromWeb(request, yield* (yield* Ref.get(answer))(received));
      }),
    );
  }),
);

const setAnswer = (answer: Answer) =>
  Effect.flatMap(Upstreams, (upstreams) => Ref.set(upstreams.answer, answer));

const sentTo = (prefix: string) =>
  Effect.map(
    Effect.flatMap(Upstreams, ({ sent }) => Ref.get(sent)),
    (all) => all.filter(({ url }) => url.startsWith(prefix)),
  );

const tokenRequests = sentTo(TOKEN_URL);
const backendRequests = sentTo(BACKEND);

/** Answers the token endpoint with new tokens that expire an hour from now, and the backend with `backend`. */
const refreshing =
  (
    backend: (sent: Sent) => Response = () => new Response("data: ok\n\n", { status: 200 }),
    nonce = "second",
  ): Answer =>
  (sent) =>
    sent.url.startsWith(TOKEN_URL)
      ? Effect.map(DateTime.now, (now) =>
          json(200, {
            access_token: chatGptAccessToken(DateTime.add(now, { hours: 1 }), nonce),
            refresh_token: `refresh-${nonce}`,
            id_token: fakeJwt({ nonce }),
          }),
        )
      : Effect.succeed(backend(sent));

/** Writes a Codex `auth.json` in a temporary directory removed with the scope, and returns the login. */
const authFile = (accessExpiresIn: Duration.Input, refresh = "refresh-first") =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "usine-chatgpt-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const path = join(directory, "auth.json");
    const now = yield* DateTime.now;
    yield* Effect.promise(() =>
      writeFile(
        path,
        authFileText({
          access: chatGptAccessToken(DateTime.addDuration(now, accessExpiresIn)),
          refresh,
        }),
      ),
    );
    return {
      directory,
      path,
      login: new ChatGptLogin({
        authFile: HostFilePath.make(path),
        tokenUrl: UpstreamBase.make(TOKEN_URL),
      }),
    };
  });

/** Rewrites the auth file at `path` with a new login. */
const replaceAuthFile = (path: string, refresh: string, accessExpiresIn: Duration.Input) =>
  Effect.flatMap(DateTime.now, (now) =>
    Effect.promise(() =>
      writeFile(
        path,
        authFileText({
          access: chatGptAccessToken(DateTime.addDuration(now, accessExpiresIn), refresh),
          refresh,
        }),
      ),
    ),
  );

/** The fields of an auth file after the Gateway wrote rotated tokens to it. */
const WrittenAuthFile = Schema.fromJsonString(
  Schema.Struct({
    auth_mode: Schema.String,
    OPENAI_API_KEY: Schema.Null,
    tokens: Schema.Struct({
      access_token: Schema.String,
      refresh_token: Schema.String,
      id_token: Schema.String,
      account_id: Schema.String,
    }),
    last_refresh: Schema.String,
  }),
);

const readWritten = (path: string) =>
  Effect.promise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(WrittenAuthFile)),
  );

const logins = ChatGptLogins.layer.pipe(
  Layer.provide(fakeClient),
  Layer.provideMerge(Upstreams.layer),
  Layer.provide(NodeFileSystem.layer),
);

const accessToken = (login: ChatGptLogin) =>
  Effect.flatMap(ChatGptLogins, (service) => service.access(login)).pipe(
    Effect.map(({ accessToken }) => Redacted.value(accessToken)),
  );

describe("ChatGptLogins", () => {
  it.effect(
    "uses the file's access token until it expires within five minutes, then refreshes it with Codex's refresh request",
    () =>
      Effect.gen(function* () {
        const { login } = yield* authFile("60 minutes");
        yield* setAnswer(refreshing());
        assert.strictEqual(nonceOf(yield* accessToken(login)), "first");
        yield* TestClock.adjust("54 minutes");
        assert.strictEqual(nonceOf(yield* accessToken(login)), "first");
        assert.lengthOf(yield* tokenRequests, 0);

        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");
        const [refresh] = yield* tokenRequests;
        assert(refresh !== undefined);
        assert.strictEqual(refresh.method, "POST");
        assert.deepStrictEqual(JSON.parse(refresh.body), {
          client_id: CODEX_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: "refresh-first",
        });
        assert.deepStrictEqual(
          Headers.get(refresh.headers, "content-type"),
          Option.some("application/json"),
        );
        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");
        assert.lengthOf(yield* tokenRequests, 1);
      }).pipe(Effect.provide(logins)),
  );

  it.effect(
    "writes the rotated tokens back to the auth file atomically, keeping its other fields",
    () =>
      Effect.gen(function* () {
        const { directory, path, login } = yield* authFile("2 minutes");
        yield* setAnswer(refreshing());
        yield* accessToken(login);
        const written = yield* readWritten(path);
        assert.strictEqual(nonceOf(written.tokens.access_token), "second");
        assert.strictEqual(written.tokens.refresh_token, "refresh-second");
        assert.strictEqual(written.tokens.id_token, fakeJwt({ nonce: "second" }));
        assert.strictEqual(written.tokens.account_id, CHATGPT_ACCOUNT);
        assert.strictEqual(written.auth_mode, "chatgpt");
        assert.isNull(written.OPENAI_API_KEY);
        assert.strictEqual(written.last_refresh, DateTime.formatIso(yield* DateTime.now));
        const { mode } = yield* Effect.promise(() => stat(path));
        assert.strictEqual(mode & 0o777, 0o600);
        assert.deepStrictEqual(yield* Effect.promise(() => readdir(directory)), ["auth.json"]);
      }).pipe(Effect.provide(logins)),
  );

  it.effect("concurrent requests share one refresh", () =>
    Effect.gen(function* () {
      const { login } = yield* authFile("1 minute");
      const service = yield* ChatGptLogins;
      yield* service.reload(login);
      const arrived = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const answer = refreshing();
      yield* setAnswer((sent) =>
        Deferred.succeed(arrived, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(answer(sent)),
        ),
      );
      const requests = yield* Effect.forEach(Array.from({ length: 10 }), () =>
        Effect.forkChild(accessToken(login)),
      );
      yield* Deferred.await(arrived);
      yield* Deferred.succeed(release, undefined);
      const tokens = yield* Fiber.joinAll(requests);
      assert.deepStrictEqual(new Set(tokens.map(nonceOf)), new Set(["second"]));
      assert.lengthOf(yield* tokenRequests, 1);
    }).pipe(Effect.provide(logins)),
  );

  it.effect(
    "a failed refresh fails the waiting requests instead of using the old token, and a request after the backoff tries again",
    () =>
      Effect.gen(function* () {
        const { login } = yield* authFile("1 minute");
        yield* setAnswer(() => Effect.succeed(json(503, { error: "temporarily_unavailable" })));
        const failures = yield* Effect.all(
          Array.from({ length: 5 }, () => Effect.flip(accessToken(login))),
          { concurrency: "unbounded" },
        );
        for (const failed of failures) {
          assert.strictEqual(failed._tag, "ChatGptLoginUnavailable");
          assert.strictEqual(failed.reason, "refresh-failed");
        }
        assert.lengthOf(yield* tokenRequests, 1, "the waiting requests share one refresh");

        yield* setAnswer(refreshing());
        assert.strictEqual((yield* Effect.flip(accessToken(login))).reason, "refresh-failed");
        assert.lengthOf(yield* tokenRequests, 1, "a request during the backoff calls nothing");

        yield* TestClock.adjust("10 seconds");
        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");
        assert.lengthOf(yield* tokenRequests, 2);
      }).pipe(Effect.provide(logins)),
  );

  it.effect("keeps the token endpoint's error text out of messages unless it's an error code", () =>
    Effect.gen(function* () {
      const { login } = yield* authFile("1 minute");
      yield* setAnswer(() =>
        Effect.succeed(json(400, { error: "refresh token rt-leaked-in-an-error is invalid" })),
      );
      const failed = yield* Effect.flip(accessToken(login));
      assert.strictEqual(failed.reason, "refresh-rejected");
      assert.notInclude(failed.message, "rt-leaked-in-an-error");
    }).pipe(Effect.provide(logins)),
  );

  for (const status of [408, 429, 500, 503])
    it.effect(`treats a ${String(status)} from the token endpoint as transient`, () =>
      Effect.gen(function* () {
        const { login } = yield* authFile("1 minute");
        yield* setAnswer(() => Effect.succeed(json(status, { error: "try_again" })));
        assert.strictEqual((yield* Effect.flip(accessToken(login))).reason, "refresh-failed");
      }).pipe(Effect.provide(logins)),
    );

  it.effect(
    "a request that ends during a refresh doesn't stop it, so the rotated token is kept",
    () =>
      Effect.gen(function* () {
        const { path, login } = yield* authFile("1 minute");
        yield* (yield* ChatGptLogins).reload(login);
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const answer = refreshing();
        yield* setAnswer((sent) =>
          Deferred.succeed(arrived, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(answer(sent)),
          ),
        );
        const caller = yield* Effect.forkChild(accessToken(login));
        yield* Deferred.await(arrived);
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(release, undefined);

        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");
        assert.lengthOf(yield* tokenRequests, 1);
        assert.strictEqual((yield* readWritten(path)).tokens.refresh_token, "refresh-second");
      }).pipe(Effect.provide(logins)),
  );

  it.effect("a 401 right after a refresh doesn't refresh again until a minute has passed", () =>
    Effect.gen(function* () {
      const { login } = yield* authFile("1 minute");
      const service = yield* ChatGptLogins;
      yield* setAnswer(refreshing());
      const refreshed = yield* service.access(login);
      yield* service.refused(login, refreshed);
      assert.strictEqual(nonceOf(yield* accessToken(login)), "second");
      assert.lengthOf(yield* tokenRequests, 1);

      yield* TestClock.adjust("1 minute");
      yield* service.refused(login, refreshed);
      yield* accessToken(login);
      assert.lengthOf(yield* tokenRequests, 2);
    }).pipe(Effect.provide(logins)),
  );

  it.effect("accepts null optional fields in the refresh answer, as Codex does", () =>
    Effect.gen(function* () {
      const { path, login } = yield* authFile("1 minute");
      yield* setAnswer(() =>
        Effect.map(DateTime.now, (now) =>
          json(200, {
            access_token: chatGptAccessToken(DateTime.add(now, { hours: 1 }), "second"),
            refresh_token: null,
            id_token: null,
          }),
        ),
      );
      assert.strictEqual(nonceOf(yield* accessToken(login)), "second");
      assert.strictEqual((yield* readWritten(path)).tokens.refresh_token, "refresh-first");
    }).pipe(Effect.provide(logins)),
  );

  it.effect(
    "leaves an auth file the operator replaced during a refresh, and the next reload takes its login",
    () =>
      Effect.gen(function* () {
        const { path, login } = yield* authFile("1 minute");
        const answer = refreshing();
        yield* setAnswer((sent) =>
          replaceAuthFile(path, "refresh-operator", "60 minutes").pipe(
            Effect.andThen(answer(sent)),
          ),
        );
        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");
        assert.strictEqual((yield* readWritten(path)).tokens.refresh_token, "refresh-operator");

        yield* (yield* ChatGptLogins).reload(login);
        assert.strictEqual(nonceOf(yield* accessToken(login)), "refresh-operator");
      }).pipe(Effect.provide(logins)),
  );

  it.effect(
    "a reload of another auth file with a refresh token this login replaced keeps the rotated one",
    () =>
      Effect.gen(function* () {
        const { directory, login } = yield* authFile("1 minute");
        yield* setAnswer(refreshing());
        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");
        const moved = join(directory, "moved.json");
        yield* replaceAuthFile(moved, "refresh-first", "60 minutes");
        const elsewhere = new ChatGptLogin({ ...login, authFile: HostFilePath.make(moved) });
        yield* (yield* ChatGptLogins).reload(elsewhere);
        assert.strictEqual(nonceOf(yield* accessToken(elsewhere)), "second");
        assert.lengthOf(yield* tokenRequests, 1);
      }).pipe(Effect.provide(logins)),
  );

  it.effect.skipIf(process.getuid?.() === 0)(
    "reports an auth file whose directory the gateway can't write to",
    () =>
      Effect.gen(function* () {
        const { directory, path } = yield* authFile("60 minutes");
        yield* Effect.acquireRelease(
          Effect.promise(() => chmod(directory, 0o500)),
          () => Effect.promise(() => chmod(directory, 0o700)),
        );
        const failed = yield* Effect.flip(checkAuthFileWritable(path));
        assert.strictEqual(failed.operation, "write");
        assert.include(failed.message, "can't write next to");
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  for (const [status, body] of [
    [400, { error: "invalid_grant", error_description: "Refresh token is invalid" }],
    [400, { error: { code: "refresh_token_reused", message: "Already used" } }],
    [401, { error: "unauthorized" }],
    [403, {}],
  ] as const)
    it.effect(
      `a refresh rejected with ${String(status)} ${JSON.stringify(body)} stops refreshing until a reload reads a new login`,
      () =>
        Effect.gen(function* () {
          const { path, login } = yield* authFile("1 minute");
          yield* setAnswer(() => Effect.succeed(json(status, body)));
          const rejected = yield* Effect.flip(accessToken(login));
          assert.strictEqual(rejected.reason, "refresh-rejected");
          assert.include(rejected.message, path);
          const again = yield* Effect.flip(accessToken(login));
          assert.strictEqual(again.reason, "refresh-rejected");
          assert.lengthOf(yield* tokenRequests, 1);

          yield* replaceAuthFile(path, "refresh-new", "60 minutes");
          yield* (yield* ChatGptLogins).reload(login);
          assert.strictEqual(nonceOf(yield* accessToken(login)), "refresh-new");
          assert.lengthOf(yield* tokenRequests, 1);
        }).pipe(Effect.provide(logins)),
    );

  it.effect(
    "a reload keeps the tokens in memory when the file has their refresh token or one they replaced, and takes a new login",
    () =>
      Effect.gen(function* () {
        const { path, login } = yield* authFile("1 minute");
        const service = yield* ChatGptLogins;
        yield* setAnswer(refreshing());
        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");

        yield* service.reload(login);
        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");

        yield* replaceAuthFile(path, "refresh-first", "60 minutes");
        yield* service.reload(login);
        assert.strictEqual(nonceOf(yield* accessToken(login)), "second");

        yield* replaceAuthFile(path, "refresh-other", "60 minutes");
        yield* service.reload(login);
        assert.strictEqual(nonceOf(yield* accessToken(login)), "refresh-other");
        assert.lengthOf(yield* tokenRequests, 1);
      }).pipe(Effect.provide(logins)),
  );

  it.effect("an auth file without ChatGPT tokens is reported without its contents", () =>
    Effect.gen(function* () {
      const { path, login } = yield* authFile("60 minutes");
      yield* Effect.promise(() =>
        writeFile(path, JSON.stringify({ OPENAI_API_KEY: "sk-proj-secretForTests" })),
      );
      const unreadable = yield* Effect.flip(accessToken(login));
      assert.strictEqual(unreadable.reason, "unreadable");
      assert.notInclude(unreadable.message, "sk-proj-secretForTests");
    }).pipe(Effect.provide(logins)),
  );
});

const chatGptProviders = (login: ChatGptLogin): LlmProviders => ({
  ...NO_PROVIDERS,
  openai: Option.some(
    new OpenAiProvider({ upstream: UpstreamBase.make(BACKEND), credential: login }),
  ),
});

const proxyFor = (login: ChatGptLogin) =>
  GatewayProxy.layer.pipe(
    Layer.provideMerge(gatewayServices),
    Layer.provide(fakeClient),
    Layer.provideMerge(Upstreams.layer),
    Layer.provideMerge(settingsLayer(chatGptProviders(login))),
    Layer.provide(NodeFileSystem.layer),
  );

/** Attaches the test repository and returns the caller token. */
const attach = Effect.gen(function* () {
  const attachments = yield* Attachments;
  const callers = yield* CallerTokens;
  yield* attachments.attach(
    new Attachment({
      id: ATTACHMENT,
      worker: WORKER,
      repository: REPOSITORY,
      credential: new AnonymousCredential(),
      expiresAt: DateTime.add(yield* DateTime.now, { hours: 2 }),
    }),
  );
  return Redacted.value(
    yield* callers.issue(
      new CallerClaims({ attachment: ATTACHMENT, worker: WORKER, repository: REPOSITORY }),
    ),
  );
});

const send = (url: string, headers: Record<string, string>, body?: string) =>
  Effect.gen(function* () {
    const proxy = yield* GatewayProxy;
    const request = HttpServerRequest.fromWeb(
      new Request(
        url,
        body === undefined
          ? { headers }
          : {
              method: "POST",
              headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
              body,
            },
      ),
    );
    const response = yield* proxy.handle.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({ headers: Headers.set(request.headers, "host", new URL(url).host) }),
      ),
    );
    const answer = HttpServerResponse.toWeb(response);
    return {
      status: answer.status,
      reason: answer.headers.get(REFUSAL_HEADER),
      body: yield* Effect.promise(() => answer.text()),
    };
  });

describe("GatewayProxy with a ChatGPT login", () => {
  it.effect(
    "sends Codex's /openai/v1 requests to the ChatGPT backend with the login's token and account",
    () =>
      Effect.gen(function* () {
        const { login } = yield* authFile("60 minutes");
        yield* Effect.gen(function* () {
          yield* setAnswer(refreshing(() => new Response("event: done\n\n", { status: 200 })));
          const caller = yield* attach;
          const answer = yield* send(
            "http://llm.gw.test/openai/v1/responses?client_version=0.159.2",
            {
              authorization: `Bearer ${caller}`,
              "chatgpt-account-id": "another-account",
              originator: "codex_exec",
              "session-id": "session-for-tests",
              "content-type": "application/json",
            },
            '{"model":"gpt-5.5","stream":true}',
          );
          assert.deepStrictEqual(answer, { status: 200, reason: null, body: "event: done\n\n" });
          const [forwarded] = yield* backendRequests;
          assert(forwarded !== undefined);
          assert.strictEqual(forwarded.url, `${BACKEND}/responses?client_version=0.159.2`);
          assert.strictEqual(forwarded.body, '{"model":"gpt-5.5","stream":true}');
          const header = (name: string) => Headers.get(forwarded.headers, name);
          assert.strictEqual(nonceOf(Option.getOrElse(header("authorization"), () => "")), "first");
          assert.deepStrictEqual(header("chatgpt-account-id"), Option.some(CHATGPT_ACCOUNT));
          assert.deepStrictEqual(header("originator"), Option.some("codex_exec"));
          assert.deepStrictEqual(header("session-id"), Option.some("session-for-tests"));
          assert.notInclude(JSON.stringify(forwarded.headers), caller);
        }).pipe(Effect.provide(proxyFor(login)));
      }),
  );

  it.effect(
    "refuses backend paths Codex doesn't call, and encoded separators, without a refresh",
    () =>
      Effect.gen(function* () {
        const { login } = yield* authFile("1 minute");
        yield* Effect.gen(function* () {
          yield* setAnswer(refreshing());
          const caller = yield* attach;
          for (const path of [
            "/openai/responses",
            "/openai/v1",
            "/openai/v1/x%2F..%2Fconversations",
            "/openai/v1/conversations",
            "/openai/v1/responses/../../conversations",
          ]) {
            const answer = yield* send(`http://llm.gw.test${path}`, {
              authorization: `Bearer ${caller}`,
            });
            assert.deepStrictEqual([answer.status, answer.reason], [404, "unsupported-path"], path);
          }
          assert.lengthOf(yield* backendRequests, 0);
          assert.lengthOf(yield* tokenRequests, 0);
        }).pipe(Effect.provide(proxyFor(login)));
      }),
  );

  for (const [token, status, outcome] of [
    [json(502, { error: "bad_gateway" }), 503, "a transient failure, which Codex retries"],
    [json(400, { error: "invalid_grant" }), 401, "a rejected refresh token"],
  ] as const)
    it.effect(
      `answers ${String(status)} and sends nothing upstream when the login can't be refreshed after ${outcome}`,
      () =>
        Effect.gen(function* () {
          const { login } = yield* authFile("1 minute");
          yield* Effect.gen(function* () {
            yield* setAnswer(() => Effect.succeed(token.clone()));
            const caller = yield* attach;
            const answer = yield* send(
              "http://llm.gw.test/openai/v1/responses",
              { authorization: `Bearer ${caller}` },
              "{}",
            );
            assert.deepStrictEqual(
              [answer.status, answer.reason],
              [status, "provider-login-unavailable"],
            );
            assert.include(answer.body, '"reason":"provider-login-unavailable"');
            assert.lengthOf(yield* backendRequests, 0);
          }).pipe(Effect.provide(proxyFor(login)));
        }),
    );

  it.effect("refreshes before the next request when the backend refuses the access token", () =>
    Effect.gen(function* () {
      const { login } = yield* authFile("60 minutes");
      yield* Effect.gen(function* () {
        yield* setAnswer(
          refreshing((sent) =>
            nonceOf(Option.getOrElse(Headers.get(sent.headers, "authorization"), () => "")) ===
            "first"
              ? json(401, { detail: "token revoked" })
              : new Response("ok", { status: 200 }),
          ),
        );
        const caller = yield* attach;
        const ask = send(
          "http://llm.gw.test/openai/v1/responses",
          { authorization: `Bearer ${caller}` },
          "{}",
        );
        assert.strictEqual((yield* ask).status, 401);
        assert.lengthOf(yield* tokenRequests, 0);
        assert.strictEqual((yield* ask).status, 200);
        assert.lengthOf(yield* tokenRequests, 1);
      }).pipe(Effect.provide(proxyFor(login)));
    }),
  );
});

const LOOPBACK = { host: "127.0.0.1", port: 0 };

/** A stand-in ChatGPT backend that sends one event, waits for `release`, then sends another. */
const streamingBackend = (release: Promise<void>) =>
  Effect.acquireRelease(
    Effect.callback<{ origin: string; close: () => void }>((resume) => {
      const server = createServer((incoming, response) => {
        incoming.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("event: response.created\ndata: {}\n\n");
        void release.then(() => response.end("event: response.completed\ndata: {}\n\n"));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = address === null || Predicate.isString(address) ? 0 : address.port;
        resume(
          Effect.succeed({
            origin: `http://127.0.0.1:${String(port)}`,
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        );
      });
    }),
    (backend) => Effect.sync(backend.close),
  );

describe("the Node gateway with a ChatGPT login", () => {
  it.live("streams the backend's events to the Worker as they arrive", () =>
    Effect.gen(function* () {
      const { login } = yield* authFile("60 minutes");
      let open: () => void = () => {};
      const release = new Promise<void>((resolve) => {
        open = resolve;
      });
      const backend = yield* streamingBackend(release);
      const providers: LlmProviders = {
        ...NO_PROVIDERS,
        openai: Option.some(
          new OpenAiProvider({
            upstream: UpstreamBase.make(`${backend.origin}/backend-api/codex`),
            credential: login,
          }),
        ),
      };
      yield* Effect.gen(function* () {
        const caller = yield* attach;
        const { proxy } = yield* GatewayAddresses;
        const received = yield* Effect.callback<{ first: string; whole: string }>((resume) => {
          const outgoing = request(
            {
              host: proxy.host,
              port: proxy.port,
              method: "POST",
              path: "/openai/v1/responses",
              headers: { host: "llm.gw.test", authorization: `Bearer ${caller}` },
            },
            (response) => {
              const chunks: Array<string> = [];
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => {
                chunks.push(chunk);
                if (chunks.length === 1) open();
              });
              response.once("end", () =>
                resume(Effect.succeed({ first: chunks[0] ?? "", whole: chunks.join("") })),
              );
            },
          );
          outgoing.once("error", (error) => resume(Effect.die(error)));
          outgoing.end("{}");
        });
        assert.strictEqual(received.first, "event: response.created\ndata: {}\n\n");
        assert.strictEqual(
          received.whole,
          "event: response.created\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
        );
      }).pipe(
        Effect.provide(
          gatewayLayer({ proxy: LOOPBACK, egress: LOOPBACK, admin: LOOPBACK }).pipe(
            Layer.provide(settingsLayer(providers)),
          ),
        ),
      );
    }),
  );
});

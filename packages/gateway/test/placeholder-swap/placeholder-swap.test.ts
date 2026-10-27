import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Logger, Option, Predicate, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AttachRequest, GatewayAdminApi } from "../../src/admin/api.ts";
import { AnonymousCredential } from "../../src/attachment/attachment.ts";
import {
  AnthropicProvider,
  AnthropicSubscriptionToken,
  type LlmProviders,
} from "../../src/llm/llm.ts";
import { GatewayAddresses, gatewayLayer } from "../../src/node/node.ts";
import { UpstreamBase } from "../../src/upstream.ts";
import {
  ADMIN_TOKEN_VALUE,
  NO_PROVIDERS,
  REPOSITORY,
  WORKER,
  secret,
  settingsLayer,
} from "../fixtures.ts";

/*
 * Checks whether Claude Code works when the Worker has only a placeholder subscription token
 * and the Gateway swaps in the real one. Run with
 * `pnpm --filter @usine/gateway test:placeholder-swap`; requires `claude` on PATH. The stub
 * check runs Claude Code against a local Anthropic stub and records the requests. The live
 * check also requires a real token from `claude setup-token` in CLAUDE_CODE_OAUTH_TOKEN and
 * is skipped without it.
 */

const STUB_SUBSCRIPTION_TOKEN = "sk-ant-oat01-stub-subscription-token-for-the-swap-check";
const LIVE_TOKEN = Option.fromNullishOr(process.env.CLAUDE_CODE_OAUTH_TOKEN).pipe(
  Option.filter((token) => token.trim() !== ""),
);
const LOOPBACK = { host: "127.0.0.1", port: 0 };

const installed = (command: string) =>
  (process.env.PATH ?? "").split(":").some((directory) => existsSync(join(directory, command)));

interface Seen {
  readonly path: string;
  readonly authorization: string;
  readonly beta: string;
  readonly apiKey: boolean;
}

const SSE_ANSWER = [
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_stub",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ],
  [
    "content_block_start",
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ],
  [
    "content_block_delta",
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
]
  .map(([event, data]) => `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`)
  .join("");

const JSON_ANSWER = JSON.stringify({
  id: "msg_stub",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** A stand-in for api.anthropic.com that records each request and responds "OK". */
const anthropicStub = Effect.acquireRelease(
  Effect.callback<{ port: number; seen: Array<Seen>; close: () => void }>((resume) => {
    const seen: Array<Seen> = [];
    const server = createServer((request: IncomingMessage, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        seen.push({
          path: request.url ?? "",
          authorization: request.headers.authorization ?? "",
          beta: request.headers["anthropic-beta"]?.toString() ?? "",
          apiKey: request.headers["x-api-key"] !== undefined,
        });
        if (!(request.url ?? "").startsWith("/v1/messages")) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }),
          );
          return;
        }
        const streaming = body.includes('"stream":true');
        response.writeHead(200, {
          "content-type": streaming ? "text/event-stream" : "application/json",
        });
        response.end(streaming ? SSE_ANSWER : JSON_ANSWER);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address === null || Predicate.isString(address) ? 0 : address.port;
      resume(Effect.succeed({ port, seen, close: () => server.close() }));
    });
  }),
  (stub) => Effect.sync(stub.close),
);

const runClaude = (env: Record<string, string>) =>
  Effect.callback<{ code: number; stdout: string; stderr: string }>((resume) => {
    const child = execFile(
      "claude",
      ["-p", "Reply with the single word OK.", "--model", "haiku"],
      { env, timeout: 180_000 },
      (error, stdout, stderr) =>
        resume(
          Effect.succeed({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr }),
        ),
    );
    child.stdin?.end();
  });

/** Runs Claude Code on a test Worker whose only Anthropic credential is the Gateway's caller token. */
const swap = (providers: LlmProviders) =>
  Effect.gen(function* () {
    const { proxy, egress, admin } = yield* GatewayAddresses;
    const client = yield* HttpApiClient.make(GatewayAdminApi, {
      baseUrl: `http://${admin.host}:${admin.port}`,
      transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(ADMIN_TOKEN_VALUE)),
    });
    const attached = yield* client.attachments.attach({
      payload: new AttachRequest({
        worker: WORKER,
        repository: REPOSITORY,
        credential: new AnonymousCredential(),
        expiresAt: DateTime.add(yield* DateTime.now, { minutes: 10 }),
      }),
    });
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "usine-swap-"))),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const placeholder = Redacted.value(attached.callerToken);
    return yield* runClaude({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_BASE_URL: "http://llm.gw.test/anthropic",
      CLAUDE_CODE_OAUTH_TOKEN: placeholder,
      // The base URL is plain HTTP through the reverse proxy; anything else goes to the egress proxy, which logs it.
      HTTP_PROXY: `http://${proxy.host}:${proxy.port}`,
      http_proxy: `http://${proxy.host}:${proxy.port}`,
      HTTPS_PROXY: `http://${egress.host}:${egress.port}`,
      https_proxy: `http://${egress.host}:${egress.port}`,
      DISABLE_AUTOUPDATER: "1",
    }).pipe(Effect.map((result) => ({ ...result, placeholder })));
  }).pipe(
    Effect.provide(
      gatewayLayer({ proxy: LOOPBACK, egress: LOOPBACK, admin: LOOPBACK }).pipe(
        Layer.provide(settingsLayer(providers)),
        Layer.provideMerge(FetchHttpClient.layer),
      ),
    ),
  );

const subscription = (upstream: string, token: string): LlmProviders => ({
  ...NO_PROVIDERS,
  anthropic: Option.some(
    new AnthropicProvider({
      upstream: UpstreamBase.make(upstream),
      credential: new AnthropicSubscriptionToken({ token: secret(token) }),
    }),
  ),
});

const egressAttempts: Array<string> = [];
const recordEgress = Logger.layer(
  [
    Logger.make(({ message }) => {
      const line = JSON.stringify(message);
      if (line.includes("Gateway refused a request") || line.includes("Opened an egress tunnel"))
        egressAttempts.push(line);
    }),
  ],
  { mergeWithExisting: true },
);

describe("placeholder swap for a Claude subscription", () => {
  it.live.skipIf(!installed("claude"))(
    "Claude Code sends its requests to the gateway with the placeholder, and the stub sees the swapped token",
    () =>
      Effect.gen(function* () {
        const stub = yield* anthropicStub;
        const result = yield* swap(
          subscription(`http://127.0.0.1:${stub.port}`, STUB_SUBSCRIPTION_TOKEN),
        );
        yield* Effect.logInfo("Placeholder swap against the stub", {
          exitCode: result.code,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim().slice(0, 500),
          requests: stub.seen.map(({ path, authorization, beta, apiKey }) => ({
            path,
            swapped: authorization === `Bearer ${STUB_SUBSCRIPTION_TOKEN}`,
            placeholderLeaked: authorization.includes(result.placeholder),
            beta,
            apiKey,
          })),
          egress: egressAttempts,
        });
        const messages = stub.seen.filter(({ path }) => path.startsWith("/v1/messages"));
        assert.isAbove(messages.length, 0, "Claude Code sent no Messages request to the base URL");
        for (const request of messages) {
          assert.strictEqual(request.authorization, `Bearer ${STUB_SUBSCRIPTION_TOKEN}`);
          assert.include(request.beta, "oauth-2025-04-20");
        }
        assert.strictEqual(result.code, 0, result.stderr);
        assert.include(result.stdout, "OK");
      }).pipe(Effect.provide(recordEgress)),
    240_000,
  );

  it.live.skipIf(!installed("claude") || Option.isNone(LIVE_TOKEN))(
    "Claude Code answers through the gateway with a real subscription token swapped in",
    () =>
      Effect.gen(function* () {
        const token = Option.getOrElse(LIVE_TOKEN, () => "");
        const result = yield* swap(subscription("https://api.anthropic.com", token));
        yield* Effect.logInfo("Placeholder swap against api.anthropic.com", {
          exitCode: result.code,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim().slice(0, 500),
        });
        assert.strictEqual(result.code, 0, result.stderr);
        assert.include(result.stdout, "OK");
      }),
    240_000,
  );
});

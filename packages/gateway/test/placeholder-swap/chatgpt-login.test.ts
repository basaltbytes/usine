import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Predicate, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { AttachRequest, GatewayAdminApi } from "../../src/admin/api.ts";
import { AnonymousCredential } from "../../src/attachment/attachment.ts";
import { ChatGptLogin, HostFilePath, OpenAiProvider } from "../../src/llm/llm.ts";
import { GatewayAddresses, gatewayLayer } from "../../src/node/node.ts";
import { UpstreamBase } from "../../src/upstream.ts";
import {
  ADMIN_TOKEN_VALUE,
  CHATGPT_ACCOUNT,
  NO_PROVIDERS,
  REPOSITORY,
  WORKER,
  authFileText,
  chatGptAccessToken,
  settingsLayer,
} from "../fixtures.ts";

/*
 * Checks that Codex works when the Worker has only the Gateway's caller token and the Gateway
 * holds the ChatGPT login. Run with `pnpm --filter @usine/gateway test:placeholder-swap`;
 * requires `codex` on PATH. Codex runs with the `model_provider` the executor writes for an
 * Attempt, against a local stand-in for the ChatGPT backend and its token endpoint, so nothing
 * reaches OpenAI. The login's access token expires within the refresh window, so the Gateway
 * refreshes it before it forwards Codex's request.
 */

const LOOPBACK = { host: "127.0.0.1", port: 0 };

const installed = (command: string) =>
  (process.env.PATH ?? "").split(":").some((directory) => existsSync(join(directory, command)));

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly account: string;
  readonly originator: string;
  readonly body: string;
}

/** Returns a Responses API event stream; each event's `type` is also its SSE event name. */
const sse = (
  events: ReadonlyArray<{ readonly type: string; readonly [field: string]: Schema.Json }>,
) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const ANSWER = sse([
  { type: "response.created", response: { id: "resp_stand_in" } },
  {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id: "msg_stand_in",
      content: [{ type: "output_text", text: "OK" }],
    },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_stand_in",
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      },
    },
  },
]);

/** A stand-in for chatgpt.com/backend-api/codex and auth.openai.com/oauth/token that records each request. */
const chatGptStandIn = Effect.acquireRelease(
  Effect.callback<{
    origin: string;
    seen: Array<Seen>;
    refreshedAccess: string;
    close: () => void;
  }>((resume) => {
    const seen: Array<Seen> = [];
    const refreshedAccess = chatGptAccessToken(
      DateTime.add(DateTime.nowUnsafe(), { hours: 1 }),
      "refreshed",
    );
    const server = createServer((request: IncomingMessage, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        seen.push({
          method: request.method ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization ?? "",
          account: request.headers["chatgpt-account-id"]?.toString() ?? "",
          originator: request.headers.originator?.toString() ?? "",
          body,
        });
        if (request.url === "/oauth/token") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ access_token: refreshedAccess, refresh_token: "rt-rotated" }),
          );
          return;
        }
        if ((request.url ?? "").startsWith("/backend-api/codex/responses")) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(ANSWER);
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: "stand-in" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address === null || Predicate.isString(address) ? 0 : address.port;
      resume(
        Effect.succeed({
          origin: `http://127.0.0.1:${String(port)}`,
          seen,
          refreshedAccess,
          close: () => {
            server.closeAllConnections();
            server.close();
          },
        }),
      );
    });
  }),
  (standIn) => Effect.sync(standIn.close),
);

/** The tokens in an auth file after the Gateway wrote a refresh to it. */
const RotatedAuthFile = Schema.fromJsonString(
  Schema.Struct({
    tokens: Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String }),
  }),
);

/** The `model_provider` the executor writes to `CODEX_HOME/config.toml` for an Attempt behind the Gateway at `gw.test`. */
const CODEX_CONFIG = `model_provider = "usine-gateway"

[model_providers.usine-gateway]
name = "usine gateway"
base_url = "http://llm.gw.test/openai/v1"
env_key = "USINE_GATEWAY_TOKEN"
wire_api = "responses"
requires_openai_auth = false
`;

const runCodex = (env: Record<string, string>, cwd: string) =>
  Effect.callback<{ code: number; stdout: string; stderr: string }>((resume) => {
    const child = execFile(
      "codex",
      ["exec", "--skip-git-repo-check", "-m", "gpt-5.5", "Reply with the single word OK."],
      { env, cwd, timeout: 180_000 },
      (error, stdout, stderr) =>
        resume(
          Effect.succeed({ code: error === null ? 0 : Number(error.code ?? 1), stdout, stderr }),
        ),
    );
    child.stdin?.end();
  });

describe("ChatGPT login at the gateway", () => {
  it.live.skipIf(!installed("codex"))(
    "Codex sends its requests to the gateway with the caller token, and the stand-in sees the refreshed ChatGPT token",
    () =>
      Effect.gen(function* () {
        const standIn = yield* chatGptStandIn;
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "usine-chatgpt-swap-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const authFile = join(directory, "auth.json");
        const expiring = chatGptAccessToken(DateTime.add(yield* DateTime.now, { minutes: 1 }));
        yield* Effect.promise(() =>
          writeFile(authFile, authFileText({ access: expiring, refresh: "rt-first" })),
        );
        const providers = {
          ...NO_PROVIDERS,
          openai: Option.some(
            new OpenAiProvider({
              upstream: UpstreamBase.make(`${standIn.origin}/backend-api/codex`),
              credential: new ChatGptLogin({
                authFile: HostFilePath.make(authFile),
                tokenUrl: UpstreamBase.make(`${standIn.origin}/oauth/token`),
              }),
            }),
          ),
        };

        const result = yield* Effect.gen(function* () {
          const { proxy, egress, admin } = yield* GatewayAddresses;
          const client = yield* HttpApiClient.make(GatewayAdminApi, {
            baseUrl: `http://${admin.host}:${admin.port}`,
            transformClient: HttpClient.mapRequest(
              HttpClientRequest.bearerToken(ADMIN_TOKEN_VALUE),
            ),
          });
          const attached = yield* client.attachments.attach({
            payload: new AttachRequest({
              worker: WORKER,
              repository: REPOSITORY,
              credential: new AnonymousCredential(),
              expiresAt: DateTime.add(yield* DateTime.now, { minutes: 10 }),
            }),
          });
          const home = join(directory, "home");
          const codexHome = join(directory, "codex");
          yield* Effect.promise(() => mkdir(home, { recursive: true }));
          yield* Effect.promise(() => mkdir(codexHome, { recursive: true }));
          yield* Effect.promise(() => writeFile(join(codexHome, "config.toml"), CODEX_CONFIG));
          const caller = Redacted.value(attached.callerToken);
          const run = yield* runCodex(
            {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: home,
              CODEX_HOME: codexHome,
              USINE_GATEWAY_TOKEN: caller,
              // The base URL is plain HTTP through the reverse proxy; anything else goes to the egress proxy, which refuses it.
              HTTP_PROXY: `http://${proxy.host}:${proxy.port}`,
              http_proxy: `http://${proxy.host}:${proxy.port}`,
              HTTPS_PROXY: `http://${egress.host}:${egress.port}`,
              https_proxy: `http://${egress.host}:${egress.port}`,
            },
            home,
          );
          return { ...run, caller };
        }).pipe(
          Effect.provide(
            gatewayLayer({ proxy: LOOPBACK, egress: LOOPBACK, admin: LOOPBACK }).pipe(
              Layer.provide(settingsLayer(providers)),
              Layer.provideMerge(FetchHttpClient.layer),
            ),
          ),
        );

        yield* Effect.logInfo("Codex through the gateway's ChatGPT login", {
          exitCode: result.code,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim().slice(-500),
          requests: standIn.seen.map(({ method, path, account, originator }) => ({
            method,
            path,
            account,
            originator,
          })),
        });
        assert.strictEqual(result.code, 0, result.stderr);
        assert.include(result.stdout, "OK");
        const refreshes = standIn.seen.filter(({ path }) => path === "/oauth/token");
        assert.lengthOf(refreshes, 1);
        assert.include(refreshes[0]?.body ?? "", '"refresh_token":"rt-first"');
        const responses = standIn.seen.filter(({ path }) =>
          path.startsWith("/backend-api/codex/responses"),
        );
        assert.isAbove(responses.length, 0, "Codex sent no Responses request to the gateway");
        for (const request of responses) {
          assert.strictEqual(request.method, "POST");
          assert.strictEqual(request.authorization, `Bearer ${standIn.refreshedAccess}`);
          assert.strictEqual(request.account, CHATGPT_ACCOUNT);
          assert.notInclude(request.body, result.caller);
        }
        const rotated = yield* Effect.promise(() => readFile(authFile, "utf8")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(RotatedAuthFile)),
        );
        assert.strictEqual(rotated.tokens.refresh_token, "rt-rotated");
        assert.strictEqual(rotated.tokens.access_token, standIn.refreshedAccess);
      }),
    240_000,
  );
});

import { createServer, type Server } from "node:net";
import { RepositoryName } from "@usine/core/repository";
import { GatewayDomain, WorkerName } from "@usine/core/worker";
import { AttachmentId } from "../src/attachment/attachment.ts";
import {
  DateTime,
  Effect,
  Encoding,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { parseEgressAllowlist } from "../src/egress/egress.ts";
import { GITHUB_ORIGINS, type GitHubOrigins } from "../src/github/github.ts";
import type { LlmProviders } from "../src/llm/llm.ts";
import { AdminToken, CallerKey, GatewaySettings, SettingsInForce } from "../src/settings.ts";

const DOMAIN = GatewayDomain.make("gw.test");
export const WORKER = WorkerName.make("worker-one");
export const OTHER_WORKER = WorkerName.make("worker-two");
export const REPOSITORY = RepositoryName.make("acme/demo");
export const OTHER_REPOSITORY = RepositoryName.make("acme/other");
export const ATTACHMENT = AttachmentId.make("attachment-one-0000000");
export const OTHER_ATTACHMENT = AttachmentId.make("attachment-two-0000000");
export const ADMIN_TOKEN_VALUE = "admin-token-for-tests-0123456789abcdef";
const CALLER_KEY_VALUE = "caller-key-for-tests-0123456789abcdef";

/** The test allowlist; `localhost` is listed so tests can check that the private-address check refuses it. */
const TEST_ALLOWLIST = ["registry.npmjs.org", "*.githubusercontent.com", "localhost"].join("\n");

/** Returns test settings with the providers a test needs, and the same values in `SettingsInForce`. */
export const settingsLayer = (
  providers: LlmProviders,
  callerKey: string = CALLER_KEY_VALUE,
  github: GitHubOrigins = GITHUB_ORIGINS,
) =>
  SettingsInForce.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(GatewaySettings)({
        domain: DOMAIN,
        github,
        providers,
        egress: Result.getOrThrow(parseEgressAllowlist(TEST_ALLOWLIST)),
        adminToken: Schema.decodeSync(AdminToken)(ADMIN_TOKEN_VALUE),
        callerKey: Schema.decodeSync(CallerKey)(callerKey),
      }),
    ),
  );

export const NO_PROVIDERS: LlmProviders = { anthropic: Option.none(), openai: Option.none() };

/** Returns an unsigned JWT with `claims`, which is all the Gateway reads of a ChatGPT token. */
export const fakeJwt = (claims: Schema.Json) =>
  [
    Encoding.encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    Encoding.encodeBase64Url(JSON.stringify(claims)),
    Encoding.encodeBase64Url("signature"),
  ].join(".");

/** Returns an access token for the ChatGPT backend that expires at `expiresAt`, with `nonce` to tell tokens apart. */
export const chatGptAccessToken = (expiresAt: DateTime.Utc, nonce = "first") =>
  fakeJwt({ exp: Math.floor(DateTime.toEpochMillis(expiresAt) / 1000), nonce });

const decodeNonce = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ nonce: Schema.String })),
);

/** Returns the `nonce` claim of a token from `chatGptAccessToken` or `fakeJwt`, or `none`. */
export const nonceOf = (jwt: string): string =>
  Option.fromNullishOr(jwt.replace(/^Bearer /u, "").split(".")[1]).pipe(
    Option.flatMap((payload) => Result.getSuccess(Encoding.decodeBase64UrlString(payload))),
    Option.flatMap(decodeNonce),
    Option.match({ onNone: () => "none", onSome: ({ nonce }) => nonce }),
  );

export const CHATGPT_ACCOUNT = "account-for-tests-0123";

/** Returns the text of a Codex `auth.json` with a ChatGPT login, as `codex login` writes it. */
export const authFileText = (tokens: { readonly access: string; readonly refresh: string }) =>
  `${JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: fakeJwt({
          email: "operator@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: CHATGPT_ACCOUNT },
        }),
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        account_id: CHATGPT_ACCOUNT,
      },
      last_refresh: "2026-10-01T00:00:00.000000Z",
    },
    null,
    2,
  )}\n`;

export const secret = (value: string) => Redacted.make(value);

/** Listens on a free loopback port until the scope closes, and returns the port. */
const heldPort = Effect.acquireRelease(
  Effect.callback<Server>((resume) => {
    const server = createServer();
    server.once("error", (error) => resume(Effect.die(error)));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.flatMap((server) => {
    const address = server.address();
    return address !== null && !Predicate.isString(address)
      ? Effect.succeed(address.port)
      : Effect.die(new Error("the probe server has no port"));
  }),
);

/**
 * Returns three distinct loopback ports for the Gateway's listeners. The three probes listen at
 * the same time, so no port repeats, but another process can bind a port before the Gateway does.
 */
export const freeGatewayPorts = Effect.all({
  proxy: heldPort,
  egress: heldPort,
  admin: heldPort,
}).pipe(Effect.scoped);

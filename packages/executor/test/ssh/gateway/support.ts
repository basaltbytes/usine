import { GatewayDomain, type GatewayLlmProvider } from "@usine/core/worker";
import {
  AdminToken,
  adminRoutes,
  Attachments,
  CallerKey,
  CallerTokens,
  GatewaySettings,
  gatewayServices,
  GITHUB_ORIGINS,
  parseEgressAllowlist,
} from "@usine/gateway";
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { StubParent, StubStorage } from "@usine/durable/testing";
import type { SshWorkerAddress } from "../../../src/ssh/ssh.ts";
import { ADDRESS, executorLayer, type fakeMachine, type mintingProvider } from "../support.ts";

const DOMAIN = GatewayDomain.make("gw.test");
const ADMIN_TOKEN = "admin-token-for-executor-tests-0123456789";
const ADMIN_URL = new URL("http://127.0.0.1:7070");

/**
 * The test Worker's address behind the Gateway at `gw.test`, presenting
 * `adminToken`. The Gateway holds the Anthropic credential unless
 * `llmProviders` says otherwise, since the test agent's brain is Claude Code.
 */
export const gatewayAddress = (
  options: {
    readonly llmProviders?: ReadonlyArray<GatewayLlmProvider>;
    readonly adminToken?: string;
  } = {},
): SshWorkerAddress => ({
  ...ADDRESS,
  gateway: Option.some({
    domain: DOMAIN,
    adminUrl: ADMIN_URL,
    adminToken: Redacted.make(options.adminToken ?? ADMIN_TOKEN),
    llmProviders: options.llmProviders ?? ["anthropic"],
  }),
});

/** An attach or renewal body as the executor sent it, before the Gateway decoded it. */
const SentAttachRequest = Schema.Struct({
  worker: Schema.String,
  repository: Schema.String,
  credential: Schema.Struct({
    _tag: Schema.Literal("InstallationCredential"),
    token: Schema.String,
  }),
  expiresAt: Schema.String,
});

/** One request the executor sent to the admin API. */
interface AdminCall {
  readonly method: string;
  readonly path: string;
  readonly body: Option.Option<typeof SentAttachRequest.Type>;
  /** How many commands the machine had run when the request was sent, to order the two. */
  readonly machineCalls: number;
}

const decoder = new TextDecoder();
const decodeAttachRequest = Schema.decodeUnknownOption(Schema.fromJsonString(SentAttachRequest));

const bodyOf = (body: { readonly _tag: string }): AdminCall["body"] =>
  "body" in body && body.body instanceof Uint8Array
    ? decodeAttachRequest(decoder.decode(body.body))
    : Option.none();

/**
 * A Gateway's real admin API and attachment store, served in memory: each
 * request runs the Gateway's own handlers in the caller's fiber, so the test
 * clock applies to expiries. `calls` records what the executor sent, and a
 * detach of an attachment in `refusedDetaches` is answered with a server error.
 */
export const fakeGateway = (machine: ReturnType<typeof fakeMachine>) => {
  const calls: Array<AdminCall> = [];
  const switches = { refusedDetaches: new Set<string>() };
  const settings = Layer.succeed(GatewaySettings)({
    domain: DOMAIN,
    github: GITHUB_ORIGINS,
    providers: { anthropic: Option.none(), openai: Option.none() },
    egress: Result.getOrThrow(parseEgressAllowlist("")),
    adminToken: Schema.decodeSync(AdminToken)(ADMIN_TOKEN),
    callerKey: Schema.decodeSync(CallerKey)("caller-key-for-executor-tests-0123456789"),
  });
  const services = gatewayServices.pipe(Layer.provideMerge(settings));
  const client = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(adminRoutes);
      const services = yield* Effect.context<Attachments | CallerTokens>();
      return HttpClient.make((request) =>
        Effect.gen(function* () {
          const path = new URL(request.url).pathname;
          calls.push({
            method: request.method,
            path,
            body: bodyOf(request.body),
            machineCalls: machine.state.calls.length,
          });
          const detached = path.slice("/v1/attachments/".length);
          if (request.method === "DELETE" && switches.refusedDetaches.has(detached))
            return HttpServerResponse.toClientResponse(
              HttpServerResponse.text("refused by the test", { status: 500 }),
              { request },
            );
          const response = yield* handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromClientRequest(request),
            ),
            Effect.orDie,
          );
          return HttpServerResponse.toClientResponse(response, { request });
        }).pipe(Effect.scoped, Effect.provide(services)),
      );
    }),
  ).pipe(Layer.provideMerge(services), Layer.provide(HttpServer.layerServices));
  return { calls, switches, layer: client };
};

/**
 * The SSH executor for the test Worker behind the in-memory Gateway, which
 * the layer also provides so a test can read its attachment store.
 */
export const gatewayRuntime = (
  machine: ReturnType<typeof fakeMachine>,
  credentials: ReturnType<typeof mintingProvider>,
  gateway: ReturnType<typeof fakeGateway>,
  options: {
    readonly address?: SshWorkerAddress;
    readonly parent?: StubParent;
    readonly storage?: StubStorage;
  } = {},
) =>
  executorLayer(
    machine,
    credentials,
    options.address ?? gatewayAddress(),
    options.parent,
    options.storage,
  ).pipe(Layer.provideMerge(gateway.layer));

/**
 * Moves the test clock forward in ten-second steps with a short real pause
 * after each. The Gateway's handlers wait on real cryptography, so an admin
 * request in flight needs real time to finish before its 30-second timeout
 * comes due on the test clock.
 */
export const advance = Effect.fn("GatewayTest.advance")(function* (minutes: number) {
  for (let step = 0; step < minutes * 6; step += 1) {
    yield* TestClock.adjust("10 seconds");
    yield* TestClock.withLive(Effect.sleep("2 millis"));
  }
});

/** The attachments the in-memory Gateway holds. */
export const attachmentsInForce = Effect.gen(function* () {
  const store = yield* Attachments;
  return yield* store.list();
});

/** What the Gateway reads from a caller token it issued. */
export const claimsOf = Effect.fn("GatewayTest.claimsOf")(function* (token: string) {
  const tokens = yield* CallerTokens;
  return yield* tokens.verify(Redacted.make(token));
});

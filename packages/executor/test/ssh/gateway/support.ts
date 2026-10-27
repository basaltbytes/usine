import {
  GatewayAdminPort,
  GatewayDomain,
  type GatewayLlmProvider,
  SshDestination,
  type WorkerName,
} from "@usine/core/worker";
import {
  AdminToken,
  adminRoutes,
  AnthropicApiKey,
  AnthropicProvider,
  Attachments,
  CallerKey,
  CallerTokens,
  GatewaySettings,
  gatewayServices,
  GITHUB_ORIGINS,
  type LlmProviders,
  parseEgressAllowlist,
  type SettingsInForce,
  UpstreamBase,
} from "@usine/gateway";
import {
  type Duration,
  Effect,
  FileSystem,
  Latch,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientError,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import type { StubParent, StubStorage } from "@usine/durable/testing";
import type { SshExecutorOptions, SshWorkerAddress } from "../../../src/ssh/ssh.ts";
import { ADDRESS, executorLayer, type fakeMachine, type mintingProvider } from "../support.ts";

const DOMAIN = GatewayDomain.make("gw.test");
const ADMIN_TOKEN = "admin-token-for-executor-tests-0123456789";
/** The Gateway's SSH destination, a Host alias. */
const GATEWAY = SshDestination.make("usine-gateway");

/**
 * Returns the test Worker's address behind the Gateway at `gw.test`, with `adminToken`. By
 * default the Gateway has the Anthropic credential because the test brain is Claude Code.
 * `name` and `gateway` select another Worker or another SSH destination for the same Gateway.
 */
export const gatewayAddress = (
  options: {
    readonly llmProviders?: ReadonlyArray<GatewayLlmProvider>;
    readonly adminToken?: string;
    readonly name?: WorkerName;
    readonly gateway?: SshDestination;
  } = {},
): SshWorkerAddress => ({
  ...ADDRESS,
  name: options.name ?? ADDRESS.name,
  gateway: Option.some({
    domain: DOMAIN,
    destination: options.gateway ?? GATEWAY,
    adminPort: GatewayAdminPort.make(7070),
    adminToken: Redacted.make(options.adminToken ?? ADMIN_TOKEN),
    llmProviders: options.llmProviders ?? ["anthropic"],
  }),
});

/** An attach or renew request body as sent by the executor, before decoding. */
const SentAttachRequest = Schema.Struct({
  worker: Schema.String,
  repository: Schema.String,
  credential: Schema.Struct({
    _tag: Schema.Literal("InstallationCredential"),
    token: Schema.String,
  }),
  expiresAt: Schema.String,
});

interface AdminCall {
  readonly method: string;
  readonly path: string;
  readonly body: Option.Option<typeof SentAttachRequest.Type>;
  /** The number of commands the machine had run when the request was sent. */
  readonly machineCalls: number;
  readonly port: number;
  /** Whether a live forward on that port delivered the request to the admin API. */
  readonly delivered: boolean;
}

const decoder = new TextDecoder();
const decodeAttachRequest = Schema.decodeUnknownOption(Schema.fromJsonString(SentAttachRequest));

const bodyOf = (body: { readonly _tag: string }): AdminCall["body"] =>
  "body" in body && body.body instanceof Uint8Array
    ? decodeAttachRequest(decoder.decode(body.body))
    : Option.none();

/** The default Gateway LLM providers: an Anthropic API key, matching `gatewayAddress`. */
const GATEWAY_PROVIDERS: LlmProviders = {
  anthropic: Option.some(
    new AnthropicProvider({
      upstream: UpstreamBase.make("https://api.anthropic.com"),
      credential: new AnthropicApiKey({ key: Redacted.make("sk-ant-api03-for-executor-tests") }),
    }),
  ),
  openai: Option.none(),
};

/**
 * Returns a Gateway's real admin API and attachment store, served in memory. Handlers run in
 * the caller's fiber, so the test clock applies to expiries. A request is handled
 * only through a live forward of `machine` on its port; otherwise it fails as a refused
 * connection.
 *
 * - `calls` records each request the executor sent, before the admin API handles it.
 * - A detach of an attachment in `refusedDetaches` returns a server error.
 * - While `answering` is false, requests get no response.
 * - While `reportsProviders` is false, the provider list returns 404.
 * - `settled` waits until no admin request is in flight.
 */
export const fakeGateway = (
  machine: ReturnType<typeof fakeMachine>,
  providers: LlmProviders = GATEWAY_PROVIDERS,
) => {
  const calls: Array<AdminCall> = [];
  const switches = { refusedDetaches: new Set<string>(), answering: true, reportsProviders: true };
  let inFlight = 0;
  const idle = Latch.makeUnsafe(true);
  const tracked = <A, E, R>(request: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        inFlight += 1;
        idle.closeUnsafe();
      }),
      () => request,
      () =>
        Effect.sync(() => {
          inFlight -= 1;
          if (inFlight === 0) idle.openUnsafe();
        }),
    );
  const settings = Layer.succeed(GatewaySettings)({
    domain: DOMAIN,
    github: GITHUB_ORIGINS,
    providers,
    egress: Result.getOrThrow(parseEgressAllowlist("")),
    adminToken: Schema.decodeSync(AdminToken)(ADMIN_TOKEN),
    callerKey: Schema.decodeSync(CallerKey)("caller-key-for-executor-tests-0123456789"),
  });
  // The admin API reads no ChatGPT login, so the logins get no file system or token endpoint.
  const noChatGptLogin = Layer.mergeAll(
    FileSystem.layerNoop({}),
    Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make(() => Effect.die(new Error("the test Gateway refreshes no ChatGPT login"))),
    ),
  );
  const services = gatewayServices.pipe(
    Layer.provideMerge(settings),
    Layer.provide(noChatGptLogin),
  );
  const client = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const handler = yield* HttpRouter.toHttpEffect(adminRoutes);
      const services = yield* Effect.context<Attachments | CallerTokens | SettingsInForce>();
      return HttpClient.make((request) =>
        Effect.gen(function* () {
          const url = new URL(request.url);
          const path = url.pathname;
          const port = Number(url.port);
          const forward = machine.state.forwards.find(
            (candidate) => candidate.port === port && candidate.live,
          );
          const delivered = forward?.carries === true && switches.answering;
          calls.push({
            method: request.method,
            path,
            body: bodyOf(request.body),
            machineCalls: machine.state.calls.length,
            port,
            delivered,
          });
          if (!delivered)
            return yield* new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description:
                  forward?.carries === true
                    ? "socket hang up"
                    : `connect ECONNREFUSED 127.0.0.1:${String(port)}`,
              }),
            });
          const detached = path.slice("/v1/attachments/".length);
          if (request.method === "DELETE" && switches.refusedDetaches.has(detached))
            return HttpServerResponse.toClientResponse(
              HttpServerResponse.text("refused by the test", { status: 500 }),
              { request },
            );
          // A Gateway without the route returns an empty 404.
          if (path === "/v1/providers" && !switches.reportsProviders)
            return HttpServerResponse.toClientResponse(HttpServerResponse.empty({ status: 404 }), {
              request,
            });
          const response = yield* handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromClientRequest(request),
            ),
            Effect.orDie,
          );
          return HttpServerResponse.toClientResponse(response, { request });
        }).pipe(Effect.scoped, Effect.provide(services), tracked),
      );
    }),
  ).pipe(Layer.provideMerge(services), Layer.provide(HttpServer.layerServices));
  return { calls, switches, layer: client, settled: idle.await };
};

/**
 * Returns the SSH executor for the test Worker behind the in-memory Gateway. The layer also
 * provides the Gateway so a test can read its attachment store.
 */
export const gatewayRuntime = (
  machine: ReturnType<typeof fakeMachine>,
  credentials: ReturnType<typeof mintingProvider>,
  gateway: ReturnType<typeof fakeGateway>,
  options: {
    readonly address?: SshWorkerAddress;
    readonly parent?: StubParent;
    readonly storage?: StubStorage;
    /** Replaces the executor's own login and binary checks; the Gateway's checks still run. */
    readonly probes?: Pick<SshExecutorOptions, "harnessReadiness">;
  } = {},
) =>
  executorLayer(
    machine,
    credentials,
    options.address ?? gatewayAddress(),
    options.parent,
    options.storage,
    options.probes,
  ).pipe(Layer.provideMerge(gateway.layer));

/**
 * Advances the test clock in ten-second steps, waiting after each until `gateway` has
 * responded to every admin request. Handlers use real cryptography, so a woken request must
 * finish before later steps trigger its 30-second timeout.
 */
export const advance = Effect.fn("GatewayTest.advance")(function* (
  gateway: ReturnType<typeof fakeGateway>,
  minutes: number,
) {
  for (let step = 0; step < minutes * 6; step += 1) {
    yield* TestClock.adjust("10 seconds");
    yield* gateway.settled;
  }
});

/**
 * Waits in real time until `holds` succeeds, advancing the test clock by `step` after each
 * wait if given. The executor picks forward ports with real I/O, which the test clock doesn't
 * drive.
 */
export const eventually = Effect.fn("GatewayTest.eventually")(function* (
  holds: () => boolean,
  step?: Duration.Input,
) {
  for (let turn = 0; turn < 400; turn += 1) {
    if (holds()) return;
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    if (step !== undefined) yield* TestClock.adjust(step);
  }
  return yield* Effect.die(new Error("The awaited condition never held"));
});

/** Returns the in-memory Gateway's attachments. */
export const attachmentsInForce = Effect.gen(function* () {
  const store = yield* Attachments;
  return yield* store.list();
});

/** Returns the claims the Gateway decodes from a caller token it issued. */
export const claimsOf = Effect.fn("GatewayTest.claimsOf")(function* (token: string) {
  const tokens = yield* CallerTokens;
  return yield* tokens.verify(Redacted.make(token));
});

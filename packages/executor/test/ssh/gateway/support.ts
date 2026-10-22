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
import { type Duration, Effect, Latch, Layer, Option, Redacted, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientError,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { StubParent, StubStorage } from "@usine/durable/testing";
import type { SshExecutorOptions, SshWorkerAddress } from "../../../src/ssh/ssh.ts";
import { ADDRESS, executorLayer, type fakeMachine, type mintingProvider } from "../support.ts";

const DOMAIN = GatewayDomain.make("gw.test");
const ADMIN_TOKEN = "admin-token-for-executor-tests-0123456789";
/** The Gateway's SSH destination, a Host alias as in the operator's SSH configuration. */
const GATEWAY = SshDestination.make("usine-gateway");

/**
 * The test Worker's address behind the Gateway at `gw.test`, presenting
 * `adminToken`. The Gateway holds the Anthropic credential unless
 * `llmProviders` says otherwise, since the test agent's brain is Claude Code.
 * `name` and `gateway` give another Worker, or the same Gateway reached
 * through another SSH destination.
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
  /** The local port the request was sent to. */
  readonly port: number;
  /** Whether a live forward on that port carried the request to the admin API. */
  readonly delivered: boolean;
}

const decoder = new TextDecoder();
const decodeAttachRequest = Schema.decodeUnknownOption(Schema.fromJsonString(SentAttachRequest));

const bodyOf = (body: { readonly _tag: string }): AdminCall["body"] =>
  "body" in body && body.body instanceof Uint8Array
    ? decodeAttachRequest(decoder.decode(body.body))
    : Option.none();

/** The Gateway's LLM providers unless a test gives others: an Anthropic API key, as `gatewayAddress` lists by default. */
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
 * A Gateway's real admin API and attachment store, served in memory: each
 * request runs the Gateway's own handlers in the caller's fiber, so the test
 * clock applies to expiries. A request reaches the handlers only through a
 * live forward of `machine` on its port, and fails as a refused connection
 * otherwise. `calls` records what the executor sent, a detach of an
 * attachment in `refusedDetaches` is answered with a server error, a request
 * while `answering` is false meets a stopped admin service and gets no
 * answer, the provider list is answered with 404, as a Gateway released
 * before it answers, while `reportsProviders` is false, and `settled` waits
 * until no admin request is in flight. The Gateway holds `providers`.
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
  const services = gatewayServices.pipe(Layer.provideMerge(settings));
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
          // The router of a Gateway without the route answers an unknown one with an empty 404.
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
 * Moves the test clock forward in ten-second steps, waiting after each until
 * `gateway` has answered every admin request. The Gateway's handlers wait on
 * real cryptography, so a request the clock woke must finish before further
 * steps bring its 30-second timeout due.
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
 * Waits in real time until `holds` does, moving the test clock by `step`
 * after each wait when one is given: the executor picks each forward's local
 * port with real I/O, which the test clock does not drive.
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

import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { CloudflareLlmProvider } from "@usine/core/worker";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  type Cause,
  DateTime,
  Duration,
  Effect,
  Layer,
  Logger,
  Match,
  Option,
  Queue,
  Redacted,
  Schema,
} from "effect";
import { HttpRouter } from "effect/unstable/http";
import { type AccessToken, accessGranted } from "./access.ts";
import { ProcessId, ProviderCredential, SandboxName, SandboxSummary } from "./api/api.ts";
import { GITHUB_HOSTS } from "./api/harness.ts";
import { AttachOffsets } from "./api/stream.ts";
import { registryRoutes, RegistryStorage, SandboxLookup } from "./registry.ts";
import { allowedHostsOf, gitHubRequest, providerRequest } from "./sandbox/outbound.ts";
import {
  ContainerFailure,
  type ContainerOperation,
  SandboxContainer,
  SandboxDirectory,
  SandboxSettings,
  SandboxStorage,
  StoredSandbox,
} from "./sandbox/ports.ts";
import { readFromCommand } from "./sandbox/process.ts";
import { collect, keepAlive, restore, sandboxRoutes } from "./sandbox/sandbox.ts";
import { attachStream, execStream, type StreamSocket } from "./sandbox/stream.ts";

/** The bindings and variables that `wrangler.jsonc` and `wrangler secret put` give the Worker. */
interface Env {
  readonly SANDBOX: DurableObjectNamespace<AttemptSandbox>;
  readonly REGISTRY: DurableObjectNamespace<SandboxRegistry>;
  readonly ACCESS_CLIENT_ID?: string;
  readonly ACCESS_CLIENT_SECRET?: string;
  readonly ALLOWED_HOSTS?: string;
}

const WorkerVariables = Schema.Struct({
  ACCESS_CLIENT_ID: Schema.NonEmptyString,
  ACCESS_CLIENT_SECRET: Schema.NonEmptyString,
  ALLOWED_HOSTS: Schema.optionalKey(Schema.String),
});
const decodeVariables = Schema.decodeUnknownOption(WorkerVariables);

interface WorkerSettings {
  readonly access: AccessToken;
  readonly allowedHosts: ReadonlyArray<string>;
}

/** Returns the Worker's settings, or `None` if the Access service token secrets are unset. */
const settingsOf = (env: Env): Option.Option<WorkerSettings> =>
  Option.map(decodeVariables(env), (variables) => ({
    access: {
      clientId: Redacted.make(variables.ACCESS_CLIENT_ID),
      clientSecret: Redacted.make(variables.ACCESS_CLIENT_SECRET),
    },
    allowedHosts: allowedHostsOf(variables.ALLOWED_HOSTS ?? ""),
  }));

const logger = Logger.layer([Logger.consoleJson]);

/** Runs `effect` with the Worker's JSON logger. */
const run = <A>(effect: Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(logger)));

/** The name of the Durable Object that answers `/v1/health`. It never starts a container. */
const HEALTH_SANDBOX = "usine-health";
/** The name of the registry Durable Object. */
const REGISTRY = "usine-registry";

const ROUTES = {
  health: /^\/v1\/health$/u,
  registry: /^\/v1\/sandboxes$/u,
  sandbox: /^\/v1\/sandboxes\/([^/]+)(?:\/.*)?$/u,
  exec: /^\/v1\/sandboxes\/([^/]+)\/exec$/u,
  attach: /^\/v1\/sandboxes\/([^/]+)\/processes\/([^/]+)\/attach$/u,
} as const;

const decodeSandboxName = Schema.decodeUnknownOption(SandboxName);
const decodeProcessId = Schema.decodeUnknownOption(ProcessId);
const decodeOffsets = Schema.decodeUnknownOption(AttachOffsets);

const plain = (status: number, message: string) =>
  new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * The Worker's HTTP surface. Every request must carry the Access service token; the routes go to
 * the sandbox's Durable Object, the registry, or any sandbox Durable Object for the health check.
 */
export default {
  async fetch(request, env) {
    const settings = settingsOf(env);
    if (Option.isNone(settings)) {
      await run(
        Effect.logError(
          "The Worker has no Access service token; set ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET with wrangler secret put",
        ),
      );
      return plain(500, "The Worker has no Access service token configured.\n");
    }
    const url = new URL(request.url);
    if (!(await run(accessGranted(request.headers, settings.value.access)))) {
      await run(
        Effect.logWarning("Refused a request without the Access service token", {
          path: url.pathname,
        }),
      );
      return plain(401, "The request lacks the Access service token.\n");
    }
    if (ROUTES.health.test(url.pathname))
      return env.SANDBOX.getByName(HEALTH_SANDBOX).fetch(request);
    if (ROUTES.registry.test(url.pathname)) return env.REGISTRY.getByName(REGISTRY).fetch(request);
    const name = decodeSandboxName(ROUTES.sandbox.exec(url.pathname)?.[1]);
    if (Option.isNone(name)) return plain(404, "Not found.\n");
    return env.SANDBOX.getByName(name.value).fetch(request);
  },
} satisfies ExportedHandler<Env>;

const containerFailure = (operation: ContainerOperation) => (cause: unknown) =>
  new ContainerFailure({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const isMissingFile = (cause: unknown): boolean =>
  SandboxFileError.is(cause) && cause.code === "ENOENT";

/** Returns the `SandboxContainer` over the Durable Object Container API and the Sandbox SDK. */
const containerOf = (
  container: Container,
  exports: Cloudflare.Exports,
): SandboxContainer["Service"] => {
  const files = new Files(container);
  const tryContainer = <A>(operation: ContainerOperation, evaluate: () => Promise<A>) =>
    Effect.tryPromise({ try: evaluate, catch: containerFailure(operation) });
  return {
    running: Effect.sync(() => container.running),
    images: Effect.sync(() => container.images),
    start: (image, instanceType) =>
      Effect.try({
        try: () => container.start({ image, instance: instanceType, enableInternet: false }),
        catch: containerFailure("start"),
      }),
    exec: (command, stdin) =>
      tryContainer("exec", () =>
        container.exec(
          [...command],
          stdin === "pipe"
            ? { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
            : { stdout: "pipe", stderr: "pipe" },
        ),
      ),
    read: (path) =>
      tryContainer("read", async () => {
        try {
          const response = await files.readFile(path);
          return Option.some(new Uint8Array(await response.arrayBuffer()));
        } catch (cause) {
          if (isMissingFile(cause)) return Option.none();
          throw cause;
        }
      }),
    readFrom: (path, offset) =>
      tryContainer("read", () =>
        container.exec([...readFromCommand(path, offset)], { stdout: "pipe", stderr: "pipe" }),
      ).pipe(
        Effect.flatMap((process) => collect(process)),
        Effect.flatMap(({ stdout, exitCode, stderr }) =>
          exitCode === 0
            ? Effect.succeed(Option.some(new TextEncoder().encode(stdout)))
            : stderr.includes("No such file")
              ? Effect.succeedNone
              : Effect.fail(new ContainerFailure({ operation: "read", message: stderr.trim() })),
        ),
      ),
    size: (path) =>
      tryContainer("read", async () => {
        try {
          return Option.some(Number((await files.stat(path)).size));
        } catch (cause) {
          if (isMissingFile(cause)) return Option.none();
          throw cause;
        }
      }),
    destroy: tryContainer("destroy", () => container.destroy()),
    keepAlive: (inactivity) =>
      tryContainer("keep-alive", () =>
        container.setInactivityTimeout(Duration.toMillis(inactivity)),
      ),
    intercept: (interception) =>
      Match.valueTags(interception, {
        GitHub: ({ host, token }) =>
          tryContainer("intercept", () =>
            container.interceptOutboundHttps(
              host,
              exports.GitHubOutbound({ props: { host, token: Redacted.value(token) } }),
            ),
          ),
        Provider: ({ host, provider, credential }) =>
          tryContainer("intercept", () =>
            container.interceptOutboundHttp(
              host,
              exports.ProviderOutbound({
                props: { provider, credential: Schema.encodeSync(ProviderCredential)(credential) },
              }),
            ),
          ),
        Allowed: ({ host }) =>
          tryContainer("intercept", () =>
            container.interceptOutboundHttps(host, exports.AllowedOutbound({ props: {} })),
          ),
      }),
  };
};

const STORED_KEY = "sandbox";
const encodeStored = Schema.encodeSync(Schema.toCodecJson(StoredSandbox));
const decodeStored = Schema.decodeUnknownOption(Schema.toCodecJson(StoredSandbox));

/** Returns `SandboxStorage` over the Durable Object's storage, with the sandbox as JSON. */
const storageOf = (storage: DurableObjectStorage): SandboxStorage["Service"] => ({
  load: Effect.promise(() => storage.get(STORED_KEY)).pipe(
    Effect.map((value) => (value === undefined ? Option.none() : decodeStored(value))),
  ),
  save: (sandbox) => Effect.promise(() => storage.put(STORED_KEY, encodeStored(sandbox))),
  clear: Effect.promise(async () => {
    await storage.deleteAlarm();
    await storage.deleteAll();
  }),
  alarmAt: (at) => Effect.promise(() => storage.setAlarm(DateTime.toEpochMillis(at))),
});

const encodeSummary = Schema.encodeSync(Schema.toCodecJson(SandboxSummary));
const decodeSummary = Schema.decodeUnknownOption(Schema.toCodecJson(SandboxSummary));

/** Returns a `StreamSocket` over the server end of a `WebSocketPair`, which it accepts. */
const socketOf = (socket: WebSocket): Effect.Effect<StreamSocket> =>
  Effect.gen(function* () {
    const messages = yield* Queue.unbounded<string | Uint8Array, Cause.Done>();
    socket.accept();
    socket.addEventListener("message", (event) => {
      Queue.offerUnsafe(
        messages,
        event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : String(event.data),
      );
    });
    socket.addEventListener("close", () => Queue.endUnsafe(messages));
    socket.addEventListener("error", () => Queue.endUnsafe(messages));
    const attempt = (action: () => void) =>
      Effect.sync(() => {
        try {
          action();
        } catch {
          // The client already closed the socket.
        }
      });
    return {
      messages,
      send: (message) => attempt(() => socket.send(message)),
      close: (code, reason) => attempt(() => socket.close(code, reason)),
    } satisfies StreamSocket;
  });

/**
 * The Durable Object and container of one Attempt's sandbox. It serves the sandbox routes of
 * `SandboxApi` and the exec and attach streams, and keeps the container running with an alarm
 * while the Attempt holds its lease.
 */
export class AttemptSandbox extends DurableObject<Env> {
  readonly #services: Layer.Layer<
    SandboxContainer | SandboxStorage | SandboxDirectory | SandboxSettings
  >;
  readonly #web: (request: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container === undefined)
      throw new Error(
        "AttemptSandbox needs a container: add it to the containers of wrangler.jsonc",
      );
    const registry = env.REGISTRY.getByName(REGISTRY);
    const directory: SandboxDirectory["Service"] = {
      record: (sandbox) =>
        Effect.tryPromise(() => registry.record(encodeSummary(sandbox))).pipe(
          Effect.tapError(() =>
            Effect.logError("Could not record the sandbox in the registry", {
              sandbox: sandbox.name,
            }),
          ),
          Effect.ignore,
        ),
      forget: (name) =>
        Effect.tryPromise(() => registry.forget(name)).pipe(
          Effect.tapError(() =>
            Effect.logError("Could not remove the sandbox from the registry", { sandbox: name }),
          ),
          Effect.ignore,
        ),
    };
    this.#services = Layer.mergeAll(
      Layer.succeed(SandboxContainer)(containerOf(container, ctx.exports)),
      Layer.succeed(SandboxStorage)(storageOf(ctx.storage)),
      Layer.succeed(SandboxDirectory)(directory),
      Layer.succeed(SandboxSettings)({
        allowedHosts: Option.match(settingsOf(env), {
          onNone: () => [],
          onSome: ({ allowedHosts }) => allowedHosts,
        }),
      }),
      logger,
    );
    const web = HttpRouter.toWebHandler(
      sandboxRoutes.pipe(HttpRouter.provideRequest(this.#services)),
    );
    this.#web = (request) => web.handler(request);
    void ctx.blockConcurrencyWhile(() => this.#run(restore()));
  }

  #run<A>(
    effect: Effect.Effect<
      A,
      never,
      SandboxContainer | SandboxStorage | SandboxDirectory | SandboxSettings
    >,
  ) {
    return Effect.runPromise(effect.pipe(Effect.provide(this.#services)));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const exec = ROUTES.exec.exec(url.pathname);
    const attach = ROUTES.attach.exec(url.pathname);
    if (exec === null && attach === null) return this.#web(request);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return plain(426, "Open this path as a WebSocket.\n");
    const name = decodeSandboxName((exec ?? attach)?.[1]);
    if (Option.isNone(name)) return plain(404, "Not found.\n");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const stream =
      attach === null
        ? Effect.flatMap(socketOf(server), (socket) => execStream(name.value, socket))
        : Option.match(
            Option.all({
              process: decodeProcessId(attach[2]),
              offsets: decodeOffsets(Object.fromEntries(url.searchParams)),
            }),
            {
              onNone: () =>
                Effect.flatMap(socketOf(server), (socket) =>
                  socket.close(1008, "Expected a process ID and stdout and stderr offsets"),
                ),
              onSome: ({ process, offsets }) =>
                Effect.flatMap(socketOf(server), (socket) =>
                  attachStream(name.value, process, offsets, socket),
                ),
            },
          );
    this.ctx.waitUntil(this.#run(stream.pipe(Effect.scoped)));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    await this.#run(keepAlive());
  }
}

/**
 * The registry of every sandbox, by owner. Sandboxes record themselves when they're created and
 * leave when they're destroyed; `/v1/sandboxes` reads each one's current state.
 */
export class SandboxRegistry extends DurableObject<Env> {
  readonly #web: (request: Request) => Promise<Response>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage: RegistryStorage["Service"] = {
      list: Effect.promise(() => ctx.storage.list({ prefix: "sandbox:" })).pipe(
        Effect.map((entries) =>
          [...entries.values()].flatMap((value) => Option.toArray(decodeSummary(value))),
        ),
      ),
      put: (sandbox) =>
        Effect.promise(() => ctx.storage.put(`sandbox:${sandbox.name}`, encodeSummary(sandbox))),
      remove: (name) =>
        Effect.promise(() => ctx.storage.delete(`sandbox:${name}`)).pipe(Effect.asVoid),
    };
    const lookup: SandboxLookup["Service"] = {
      get: (name) =>
        Effect.tryPromise(() =>
          env.SANDBOX.getByName(name).fetch(`https://sandbox.internal/v1/sandboxes/${name}`),
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.succeedNone
              : Effect.tryPromise(() => response.json()).pipe(Effect.map(decodeSummary)),
          ),
          Effect.orElseSucceed(() => Option.none<SandboxSummary>()),
        ),
    };
    const web = HttpRouter.toWebHandler(
      registryRoutes.pipe(
        HttpRouter.provideRequest(
          Layer.mergeAll(
            Layer.succeed(RegistryStorage)(storage),
            Layer.succeed(SandboxLookup)(lookup),
            logger,
          ),
        ),
      ),
    );
    this.#web = (request) => web.handler(request);
  }

  override async fetch(request: Request): Promise<Response> {
    return this.#web(request);
  }

  /** Records `sandbox`, the JSON encoding of a `SandboxSummary`. */
  async record(sandbox: Schema.Json): Promise<void> {
    const decoded = decodeSummary(sandbox);
    if (Option.isSome(decoded))
      await this.ctx.storage.put(`sandbox:${decoded.value.name}`, encodeSummary(decoded.value));
  }

  async forget(name: string): Promise<void> {
    await this.ctx.storage.delete(`sandbox:${name}`);
  }
}

const GitHubProps = Schema.Struct({
  host: Schema.Literals(GITHUB_HOSTS),
  token: Schema.NonEmptyString,
});
const ProviderProps = Schema.Struct({
  provider: CloudflareLlmProvider,
  credential: ProviderCredential,
});

/** Logs one forwarded request without its headers, body, or query string. */
const logForwarded = (handler: string, request: Request, response: Response) =>
  run(
    Effect.logInfo("Forwarded a sandbox request", {
      handler,
      method: request.method,
      host: new URL(request.url).host,
      path: new URL(request.url).pathname,
      status: response.status,
    }),
  );

/** Adds the Attempt's installation token to the sandbox's requests for GitHub. */
export class GitHubOutbound extends WorkerEntrypoint<Env, typeof GitHubProps.Encoded> {
  override async fetch(request: Request): Promise<Response> {
    const props = Schema.decodeUnknownSync(GitHubProps)(this.ctx.props);
    const response = await fetch(gitHubRequest(request, props.host, Redacted.make(props.token)));
    await logForwarded("github", request, response);
    return response;
  }
}

/** Sends the sandbox's plain HTTP requests for a provider to the provider, with its API key. */
export class ProviderOutbound extends WorkerEntrypoint<Env, typeof ProviderProps.Encoded> {
  override async fetch(request: Request): Promise<Response> {
    const props = Schema.decodeUnknownSync(ProviderProps)(this.ctx.props);
    const response = await fetch(providerRequest(request, props.provider, props.credential));
    await logForwarded(props.provider, request, response);
    return response;
  }
}

/** Forwards the sandbox's requests for an allowlisted host unchanged. */
export class AllowedOutbound extends WorkerEntrypoint<Env, Record<string, never>> {
  override async fetch(request: Request): Promise<Response> {
    const response = await fetch(request);
    await logForwarded("allowed", request, response);
    return response;
  }
}

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
      durableNamespaces: "AttemptSandbox" | "SandboxRegistry";
    }
  }
}

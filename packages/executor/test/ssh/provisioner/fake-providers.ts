import { Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

/** The base URL of the fake Hetzner Cloud API. */
export const HETZNER_TEST_API = "https://hetzner.test/v1";
/** The base URL of the fake Boat API. */
export const BOAT_TEST_API = "https://boat.test/api/v1";

const decoder = new TextDecoder();

/** A request a fake provider received. */
export interface ProviderCall {
  readonly method: string;
  /** The path after the API's base, such as `/servers/1`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** The JSON body, if the request has one. */
  readonly body: Schema.JsonObject | undefined;
}

/** A canned error response. */
export interface CannedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

interface FakeServer {
  id: number;
  name: string;
  status: string;
  created: string;
  labels: Record<string, string>;
  privateIp: string | undefined;
  publicIp: string | undefined;
  /** The number of reads left before the server runs. */
  startingReads: number;
}

interface FakeSandbox {
  id: string;
  name: string;
  state: string;
  createdAt: string;
  /** The number of reads left before the sandbox is ready. */
  provisioningReads: number;
  body: Schema.JsonObject | undefined;
}

interface HetznerState {
  readonly servers: Map<number, FakeServer>;
  nextId: number;
  nextIp: number;
  /** The bearer token the API accepts. */
  token: string;
  readonly images: ReadonlyArray<{
    readonly id: number;
    readonly type: string;
    readonly status: string;
    readonly description: string;
    readonly created: string;
  }>;
  readonly sshKeys: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly networks: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly firewalls: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly serverTypes: ReadonlyArray<{
    readonly name: string;
    readonly locations: ReadonlyArray<{ readonly name: string; readonly available: boolean }>;
  }>;
  /** The error that the next creations get, if set. */
  createFails: CannedError | undefined;
  /** Whether every request gets no response. */
  unreachable: boolean;
  /** The reads of a new server before it runs. */
  startingReads: number;
  /** The error that deletions get, if set. */
  deleteFails: CannedError | undefined;
}

interface BoatLimits {
  readonly canStart: boolean;
  readonly activeSandboxes: number;
  readonly maxActiveSandboxes: number;
  readonly starts: { readonly unlimited: boolean; readonly day: { readonly remaining: number } };
  readonly machineTypes: ReadonlyArray<{
    readonly type: string;
    readonly available: boolean;
    readonly reason: string | null;
  }>;
}

interface BoatState {
  readonly snapshots: Map<string, string>;
  readonly sandboxes: Map<string, FakeSandbox>;
  nextId: number;
  token: string;
  /** The host key the API reports, or `undefined` if it reports none. */
  hostKey: string | undefined;
  /** Boat's SSH forward, or `undefined` for a machine address of its own. */
  sshEndpoint: string | undefined;
  createFails: CannedError | undefined;
  provisioningReads: number;
  limits: BoatLimits;
  /** The page size of the sandbox listing, to test pagination. */
  pageSize: number;
}

const CreateServerBody = Schema.Struct({
  name: Schema.String,
  labels: Schema.Record(Schema.String, Schema.String),
  networks: Schema.Array(Schema.Int),
  public_net: Schema.Struct({ enable_ipv4: Schema.Boolean }),
});
const LabelsBody = Schema.Struct({ labels: Schema.Record(Schema.String, Schema.String) });
const NamedBody = Schema.Struct({ name: Schema.String });
const decodeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const json = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  status: number,
  body: Schema.Json,
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const bodyOf = (body: { readonly _tag: string }): Schema.JsonObject | undefined =>
  "body" in body && body.body instanceof Uint8Array
    ? Option.getOrUndefined(decodeBody(decoder.decode(body.body)))
    : undefined;

const unexpected = HttpClient.make(() =>
  Effect.die(new Error("an HTTP request to an unexpected origin")),
);

/**
 * Returns in-memory Hetzner Cloud and Boat APIs behind one HTTP client, with switches that make
 * a request fail. `over` sends other origins, such as a Gateway's admin API, to another client.
 */
export const fakeProviders = () => {
  const calls: Array<ProviderCall & { readonly provider: "hetzner" | "boat" }> = [];
  const hetzner: HetznerState = {
    servers: new Map<number, FakeServer>(),
    nextId: 52_341_896,
    nextIp: 5,
    /** The bearer token the API accepts. */
    token: "hcloud-token-for-tests",
    images: [
      {
        id: 301,
        type: "snapshot",
        status: "available",
        description: "usine-worker-claude-2.1.308-codex-0.159.2",
        created: "2026-10-20T10:00:00+00:00",
      },
    ],
    sshKeys: [{ id: 41, name: "usine-orchestrator" }],
    networks: [{ id: 7, name: "usine-gateway" }],
    firewalls: [{ id: 81, name: "usine-orchestrator-ssh" }],
    serverTypes: [
      {
        name: "cx33",
        locations: [
          { name: "nbg1", available: true },
          { name: "fsn1", available: false },
        ],
      },
    ],
    createFails: undefined,
    unreachable: false,
    startingReads: 1,
    deleteFails: undefined,
  };
  const boat: BoatState = {
    snapshots: new Map([["usine-attempt", "ready"]]),
    sandboxes: new Map<string, FakeSandbox>(),
    nextId: 0,
    token: "boat_key_for_tests",
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoatHostKeyForTests",
    sshEndpoint: undefined,
    createFails: undefined,
    provisioningReads: 1,
    limits: {
      canStart: true,
      activeSandboxes: 0,
      maxActiveSandboxes: 100,
      starts: { unlimited: false, day: { remaining: 140 } },
      machineTypes: [
        { type: "small", available: true, reason: null },
        { type: "default", available: true, reason: null },
        { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" },
      ],
    },
    pageSize: 200,
  };

  const serverJson = (server: FakeServer) => ({
    id: server.id,
    name: server.name,
    status: server.status,
    created: server.created,
    labels: server.labels,
    public_net: { ipv4: server.publicIp === undefined ? null : { ip: server.publicIp } },
    private_net: server.privateIp === undefined ? [] : [{ network: 7, ip: server.privateIp }],
  });

  const hetznerError = (failure: CannedError) => ({
    error: { code: failure.code, message: failure.message, details: null },
  });

  const handleHetzner = (call: ProviderCall): readonly [number, Schema.Json] => {
    if (call.headers.authorization !== `Bearer ${hetzner.token}`)
      return [
        401,
        hetznerError({ status: 401, code: "unauthorized", message: "unable to authenticate" }),
      ];
    const page = { meta: { pagination: { next_page: null } } };
    const segments = call.path.split("/").filter((segment) => segment !== "");
    if (call.method === "GET" && call.path === "/server_types")
      return [
        200,
        {
          server_types: hetzner.serverTypes.filter(({ name }) => name === call.query.name),
          ...page,
        },
      ];
    if (call.method === "GET" && call.path === "/ssh_keys")
      return [
        200,
        { ssh_keys: hetzner.sshKeys.filter(({ name }) => name === call.query.name), ...page },
      ];
    if (call.method === "GET" && call.path === "/firewalls")
      return [
        200,
        { firewalls: hetzner.firewalls.filter(({ name }) => name === call.query.name), ...page },
      ];
    if (call.method === "GET" && call.path === "/networks")
      return [
        200,
        { networks: hetzner.networks.filter(({ name }) => name === call.query.name), ...page },
      ];
    if (call.method === "GET" && call.path === "/images") {
      const images = hetzner.images.filter(
        (image) =>
          (call.query.type === undefined || image.type === call.query.type) &&
          call.query.name === undefined,
      );
      // Only system images have names, and the fake has none.
      return [200, { images, ...page }];
    }
    if (call.method === "GET" && segments[0] === "images" && segments[1] !== undefined) {
      const image = hetzner.images.find(({ id }) => String(id) === segments[1]);
      return image === undefined
        ? [404, hetznerError({ status: 404, code: "not_found", message: "image not found" })]
        : [200, { image }];
    }
    if (call.method === "POST" && call.path === "/servers") {
      if (hetzner.createFails !== undefined)
        return [hetzner.createFails.status, hetznerError(hetzner.createFails)];
      const body = Schema.decodeUnknownSync(CreateServerBody)(call.body);
      const id = hetzner.nextId++;
      const server: FakeServer = {
        id,
        name: body.name,
        status: "initializing",
        created: "2026-10-25T12:00:00+00:00",
        labels: { ...body.labels },
        privateIp: body.networks.length > 0 ? `10.42.0.${String(hetzner.nextIp++)}` : undefined,
        publicIp: body.public_net.enable_ipv4 ? `203.0.113.${String(hetzner.nextIp++)}` : undefined,
        startingReads: hetzner.startingReads,
      };
      hetzner.servers.set(id, server);
      return [
        201,
        {
          server: serverJson(server),
          action: { id: id + 1_000_000, command: "create_server", status: "running" },
          next_actions: [],
          root_password: null,
        },
      ];
    }
    if (segments[0] === "servers" && segments[1] !== undefined) {
      const server = hetzner.servers.get(Number(segments[1]));
      if (server === undefined)
        return [404, hetznerError({ status: 404, code: "not_found", message: "server not found" })];
      if (call.method === "GET") {
        if (server.startingReads > 0) server.startingReads -= 1;
        else server.status = "running";
        return [200, { server: serverJson(server) }];
      }
      if (call.method === "PUT") {
        server.labels = { ...Schema.decodeUnknownSync(LabelsBody)(call.body).labels };
        return [200, { server: serverJson(server) }];
      }
      if (call.method === "DELETE") {
        if (hetzner.deleteFails !== undefined)
          return [hetzner.deleteFails.status, hetznerError(hetzner.deleteFails)];
        hetzner.servers.delete(server.id);
        return [200, { action: { id: 9, command: "delete_server", status: "running" } }];
      }
    }
    if (call.method === "GET" && call.path === "/servers") {
      const selector = (call.query.label_selector ?? "").split(",").filter((part) => part !== "");
      const servers = [...hetzner.servers.values()].filter((server) =>
        selector.every((part) => {
          const [key = "", value = ""] = part.split("=");
          return server.labels[key] === value;
        }),
      );
      return [200, { servers: servers.map(serverJson), ...page }];
    }
    return [
      404,
      hetznerError({
        status: 404,
        code: "not_found",
        message: `no route ${call.method} ${call.path}`,
      }),
    ];
  };

  const boatError = (failure: CannedError) => ({
    ok: false,
    type: "sandbox.error",
    status: failure.status,
    code: failure.code,
    message: failure.message,
    error: { code: failure.code, message: failure.message, status: failure.status },
    requestId: "req_test",
  });

  const sandboxJson = (sandbox: FakeSandbox) => ({
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    createdAt: sandbox.createdAt,
    desktopAvailable: false,
    snapshotAvailable: false,
  });

  const handleBoat = (call: ProviderCall): readonly [number, Schema.Json] => {
    if (call.headers.authorization !== `Bearer ${boat.token}`)
      return [401, boatError({ status: 401, code: "unauthorized", message: "Unauthorized" })];
    const segments = call.path.split("/").filter((segment) => segment !== "");
    if (call.method === "GET" && call.path.startsWith("/saved-snapshots/")) {
      const name = call.path.slice("/saved-snapshots/".length);
      const status = boat.snapshots.get(name);
      return status === undefined
        ? [404, { code: "snapshot_not_found" }]
        : [200, { snapshot: { name, status } }];
    }
    if (call.method === "GET" && call.path === "/me")
      return [200, { ok: true, type: "user.info", user: { login: "operator" } }];
    if (call.method === "GET" && call.path === "/limits")
      return [200, { ok: true, type: "limits.info", ...boat.limits }];
    if (call.method === "POST" && call.path === "/sandboxes") {
      if (boat.createFails !== undefined)
        return [boat.createFails.status, boatError(boat.createFails)];
      const id = `bx_${"23456789abcdefgh".slice(0, 8 - String(boat.nextId).length)}${String(boat.nextId++)}`;
      const sandbox: FakeSandbox = {
        id,
        name: Schema.decodeUnknownSync(NamedBody)(call.body).name,
        state: "provisioning",
        createdAt: "2026-10-25T12:00:00Z",
        provisioningReads: boat.provisioningReads,
        body: call.body,
      };
      boat.sandboxes.set(id, sandbox);
      return [
        202,
        {
          ok: true,
          type: "sandbox.created",
          status: "provisioning",
          ttlSeconds: null,
          sandbox: sandboxJson(sandbox),
        },
      ];
    }
    if (call.method === "GET" && call.path === "/sandboxes") {
      const all = [...boat.sandboxes.values()];
      const start = call.query.cursor === undefined ? 0 : Number(call.query.cursor);
      const slice = all.slice(start, start + boat.pageSize);
      const next = start + boat.pageSize < all.length ? String(start + boat.pageSize) : null;
      return [
        200,
        {
          ok: true,
          type: "sandbox.list",
          sandboxes: slice.map(sandboxJson),
          pageInfo: { nextCursor: next, hasMore: next !== null, limit: boat.pageSize },
        },
      ];
    }
    if (segments[0] === "sandboxes" && segments[1] !== undefined) {
      const sandbox = boat.sandboxes.get(segments[1]);
      if (sandbox === undefined)
        return [404, boatError({ status: 404, code: "not_found", message: "Not found" })];
      if (call.method === "GET" && segments.length === 2) {
        if (sandbox.provisioningReads > 0) sandbox.provisioningReads -= 1;
        else sandbox.state = "ready";
        return [200, { ok: true, type: "sandbox.info", sandbox: sandboxJson(sandbox) }];
      }
      if (call.method === "POST" && segments[2] === "sshkey") {
        const configured = {
          ok: true,
          type: "ssh_key.configured",
          success: true,
          machineIp: "198.51.100.20",
          sshUser: "user",
          sshEndpoint: boat.sshEndpoint ?? null,
        };
        return [
          200,
          boat.hostKey === undefined ? configured : { ...configured, hostKey: boat.hostKey },
        ];
      }
      if (call.method === "PATCH") {
        sandbox.name = Schema.decodeUnknownSync(NamedBody)(call.body).name;
        return [200, { ok: true, type: "sandbox.info", sandbox: sandboxJson(sandbox) }];
      }
      if (call.method === "DELETE") {
        if (call.headers["x-ascii-confirm-delete"] !== sandbox.id)
          return [
            409,
            boatError({ status: 409, code: "confirm_delete", message: "Confirm the deletion" }),
          ];
        boat.sandboxes.delete(sandbox.id);
        return [
          202,
          { ok: true, type: "sandbox.deleting", operation: { id: "bdop_0", status: "accepted" } },
        ];
      }
    }
    return [
      404,
      boatError({
        status: 404,
        code: "not_found",
        message: `no route ${call.method} ${call.path}`,
      }),
    ];
  };

  const clientWith = (fallback: HttpClient.HttpClient) =>
    HttpClient.make((request, url) =>
      Effect.suspend(() => {
        const provider = url.href.startsWith(HETZNER_TEST_API)
          ? ("hetzner" as const)
          : url.href.startsWith(BOAT_TEST_API)
            ? ("boat" as const)
            : undefined;
        if (provider === undefined) return fallback.execute(request);
        if (provider === "hetzner" && hetzner.unreachable)
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "connect ETIMEDOUT",
              }),
            }),
          );
        const base = provider === "hetzner" ? HETZNER_TEST_API : BOAT_TEST_API;
        const call: ProviderCall = {
          method: request.method,
          path: url.pathname.slice(new URL(base).pathname.length),
          query: Object.fromEntries(url.searchParams),
          headers: Object.fromEntries(Object.entries(request.headers)),
          body: bodyOf(request.body),
        };
        calls.push({ ...call, provider });
        const [status, body] = provider === "hetzner" ? handleHetzner(call) : handleBoat(call);
        return Effect.succeed(json(request, status, body));
      }),
    );
  return {
    calls,
    hetzner,
    boat,
    layer: Layer.succeed(HttpClient.HttpClient, clientWith(unexpected)),
    /** Returns the providers' client that sends other origins to `underlying`'s client. */
    over: <E, R>(underlying: Layer.Layer<HttpClient.HttpClient, E, R>) =>
      Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, clientWith)).pipe(
        Layer.provide(underlying),
      ),
  };
};

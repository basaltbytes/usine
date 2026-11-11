import { ConnectError, createClient, type CallOptions } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { type MachineId, type BoxdRegion } from "@usine/core/worker";
import { DateTime, Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { BoxdApi as BoxdService, type GetVmResponse } from "./api-pb.ts";
import {
  BoxdApi,
  type BoxdApiLayer,
  BoxdCallError,
  type BoxdCluster,
  BoxdCreated,
  BoxdIdentity,
  BoxdLimit,
  BoxdMachine,
  BoxdRegionList,
  BoxdSnapshot,
  BoxdUnknownRegion,
  type BoxdCreate,
} from "./client.ts";
import { endpointUrl, exchangeUrl, rawKeyAllowed, refusesRawKey } from "./endpoint.ts";
import { failureCode } from "./status.ts";

class RpcRejection extends Schema.TaggedError<RpcRejection, { readonly brand: unique symbol }>()(
  "RpcRejection",
  { cause: Schema.Defect() },
) {}

/** How long before its expiry a session is exchanged again, as the boxd SDK does. */
const REFRESH_MARGIN_SECONDS = 300;
/** Returns the gRPC status name for an HTTP status of the token exchange. */
const exchangeCode = (status: number): string => {
  switch (status) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 502:
    case 503:
    case 504:
      return "UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL" : "UNKNOWN";
  }
};
const Session = Schema.Struct({ token: Schema.String, expires_at: Schema.Finite });
const machineValue = (value: GetVmResponse) => ({
  ...value,
  id: value.vmId,
  createdAt: Number(value.createdAt),
});
/**
 * Generated gRPC calls retain the serving-region metadata that the SDK omits.
 *
 * Account calls and `ListRegions` go to `cluster.endpoint`. With a region, building the layer calls
 * `ListRegions` to find the region's API endpoint, which serves machine and `Exec` calls; the
 * region that the account endpoint serves stays there. Building fails with `BoxdUnknownRegion` when
 * boxd lists no such region, or lists it without an API endpoint. Without a region, every call
 * goes to the account endpoint.
 *
 * Over TLS or to a loopback address, a call carries the API key as the bearer. Once boxd refuses
 * the key as a bearer, the layer exchanges it for a session at the URL that `exchangeUrl` derives
 * from the account endpoint, and every later call carries a session. A call that boxd refuses with
 * `UNAUTHENTICATED` on a session drops the session and runs once more with a new one. `Exec`
 * calls carry the bearer that the other calls settled on.
 */
export const boxdApiLayer = (
  token: Redacted.Redacted<string>,
  cluster: BoxdCluster,
  transport: typeof createGrpcTransport = createGrpcTransport,
): ReturnType<BoxdApiLayer> =>
  Layer.effect(
    BoxdApi,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const { endpoint } = cluster;
      const region = Option.getOrElse(cluster.region, () => "");
      const exchange = exchangeUrl(endpoint);
      const clientFor = (url: string) =>
        Effect.gen(function* () {
          const sessionManager = yield* Effect.acquireRelease(
            Effect.sync(() => new Http2SessionManager(url)),
            (manager) => Effect.sync(() => manager.abort()),
          );
          return {
            url,
            /** Whether a call may carry the API key as the bearer. */
            rawKey: rawKeyAllowed(url),
            rpc: createClient(
              BoxdService,
              transport({ baseUrl: url, sessionManager, defaultTimeoutMs: 30_000 }),
            ),
          };
        });
      type Client = Effect.Success<ReturnType<typeof clientFor>>;
      const account = yield* clientFor(endpoint);
      let session: Option.Option<typeof Session.Type> = Option.none();
      /** Whether boxd refused the API key as a bearer, so that every call carries a session. */
      let rawKeyRefused = false;
      /** Whether boxd answered a call that carried the API key as the bearer. */
      let rawKeyAccepted = false;
      const exclusive = yield* Semaphore.make(1);
      const authenticateError = (code: string, message: string) =>
        BoxdCallError.make({ operation: "authenticate", url: exchange, code, message });
      const bearer = Effect.gen(function* () {
        const now = yield* DateTime.now;
        if (
          Option.isSome(session) &&
          session.value.expires_at > DateTime.toEpochMillis(now) / 1000 + REFRESH_MARGIN_SECONDS
        )
          return session.value.token;
        yield* Effect.logInfo("Exchanging boxd API key for a session", {
          region,
          exchange,
          refreshing: Option.isSome(session),
        });
        const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(exchange), {
          api_key: Redacted.value(token),
        });
        const response = yield* http.execute(request);
        if (response.status !== 200)
          return yield* authenticateError(
            exchangeCode(response.status),
            `Token exchange returned HTTP ${response.status}`,
          );
        const decoded = yield* HttpClientResponse.schemaBodyJson(Session)(response);
        session = Option.some(decoded);
        return decoded.token;
      }).pipe(
        Effect.timeout("30 seconds"),
        exclusive.withPermit,
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(authenticateError("UNAVAILABLE", "The boxd token exchange timed out")),
          HttpClientError: () =>
            Effect.fail(
              authenticateError("UNAVAILABLE", "Could not reach the boxd token exchange"),
            ),
          HttpBodyError: () =>
            Effect.fail(authenticateError("INTERNAL", "Could not encode the token request")),
          SchemaError: () =>
            Effect.fail(authenticateError("INTERNAL", "Invalid token exchange response")),
        }),
      );
      const invokeWith = <A>(
        client: Client,
        operation: string,
        invoke: (options: CallOptions) => Promise<A>,
        credential: string,
      ) =>
        Effect.tryPromise({
          try: (signal) => invoke({ signal, headers: { authorization: `Bearer ${credential}` } }),
          catch: (cause) => RpcRejection.make({ cause }),
        }).pipe(
          Effect.catch((failure) =>
            failure.cause instanceof ConnectError
              ? Effect.fail(
                  BoxdCallError.make({
                    operation,
                    url: client.url,
                    code: failureCode(failure.cause),
                    message: failure.cause.rawMessage
                      .replaceAll(Redacted.value(token), "[redacted]")
                      .replaceAll(credential, "[redacted]"),
                  }),
                )
              : Effect.die(failure.cause),
          ),
        );
      const withSession = <A>(
        client: Client,
        operation: string,
        invoke: (options: CallOptions) => Promise<A>,
      ) =>
        Effect.gen(function* () {
          const jwt = yield* bearer;
          return yield* invokeWith(client, operation, invoke, jwt).pipe(
            Effect.catchIf(
              (failure) => failure.code === "UNAUTHENTICATED",
              () =>
                Effect.gen(function* () {
                  yield* Effect.logInfo("boxd refused the session; exchanging the API key again", {
                    region,
                    operation,
                  });
                  // A concurrent call may already hold a newer session, which stays.
                  if (Option.isSome(session) && session.value.token === jwt)
                    session = Option.none();
                  const renewed = yield* bearer;
                  return yield* invokeWith(client, operation, invoke, renewed);
                }),
            ),
          );
        });
      const call = <A>(
        client: Client,
        operation: string,
        invoke: (options: CallOptions) => Promise<A>,
      ) =>
        Effect.suspend(() =>
          client.rawKey && !rawKeyRefused
            ? invokeWith(client, operation, invoke, Redacted.value(token)).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    rawKeyAccepted = true;
                  }),
                ),
                Effect.catchIf(
                  (failure) => failure.code === "UNAUTHENTICATED" && refusesRawKey(failure.message),
                  () =>
                    Effect.gen(function* () {
                      if (!rawKeyRefused)
                        yield* Effect.logInfo(
                          "boxd refused the API key as a bearer; exchanging it for a session",
                          { region, operation, endpoint: client.url },
                        );
                      rawKeyRefused = true;
                      // boxd refused the call before any handler ran, so it runs once more.
                      return yield* withSession(client, operation, invoke);
                    }),
                ),
              )
            : withSession(client, operation, invoke),
        ).pipe(Effect.withSpan(`BoxdApi.${operation}`));
      const decode =
        <S extends Schema.Top>(client: Client, schema: S, operation: string) =>
        <A>(value: A) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(() =>
              BoxdCallError.make({
                operation,
                url: client.url,
                code: "INTERNAL",
                message: `Invalid ${operation} response`,
              }),
            ),
          );
      const listRegions = call(account, "listRegions", (opts) =>
        account.rpc.listRegions({}, opts),
      ).pipe(Effect.flatMap(decode(account, BoxdRegionList, "listRegions")));
      // The driver's boundary logs an unknown region once, with the worker.
      const regional = (configured: BoxdRegion) =>
        Effect.gen(function* () {
          const listed = yield* listRegions;
          // The region that the account endpoint serves needs no API endpoint of its own.
          const usable = listed.regions.filter(
            ({ id, apiEndpoint }) => id === listed.thisRegion || apiEndpoint.length > 0,
          );
          const match = usable.find(({ id }) => id === configured);
          if (match === undefined)
            return yield* BoxdUnknownRegion.make({
              region: configured,
              available: usable.map(({ id }) => id),
            });
          const url = match.id === listed.thisRegion ? endpoint : endpointUrl(match.apiEndpoint);
          yield* Effect.logInfo("Resolved the boxd regional endpoint", {
            region: configured,
            endpoint: url,
          });
          return url === endpoint ? account : yield* clientFor(url);
        }).pipe(Effect.withSpan("BoxdApi.resolveRegion", { attributes: { region: configured } }));
      const machines = yield* Option.match(cluster.region, {
        onNone: () =>
          Effect.logInfo("Sending every boxd call to the account endpoint", { endpoint }).pipe(
            Effect.as(account),
          ),
        onSome: regional,
      });
      const whoami = call(account, "whoami", (opts) => account.rpc.whoami({}, opts));
      const settled = Effect.suspend(() =>
        machines.rawKey && rawKeyAccepted && !rawKeyRefused
          ? Effect.succeed(token)
          : bearer.pipe(Effect.map((jwt) => Redacted.make(jwt))),
      );
      // `Exec` streams stdin, so a refused stream can't run once more with a session as `call` does.
      const execBearer = Effect.suspend(() =>
        machines.rawKey && !rawKeyAccepted && !rawKeyRefused
          ? whoami.pipe(Effect.andThen(settled))
          : settled,
      ).pipe(Effect.withSpan("BoxdApi.execBearer"));
      const client = machines.rpc;
      const list = (selector: ReadonlyArray<string>) =>
        call(machines, "listVms", (opts) => client.listVms({ labelSelector: [...selector] }, opts));
      return BoxdApi.of({
        endpoint: machines.url,
        execBearer,
        whoami: whoami.pipe(
          Effect.flatMap((value) =>
            decode(account, BoxdIdentity, "whoami")({ userId: value.userId }),
          ),
        ),
        orgMachineLimit: call(account, "orgMachineLimit", (opts) =>
          account.rpc.getOrgMachineLimit({}, opts),
        ).pipe(Effect.flatMap(decode(account, BoxdLimit, "orgMachineLimit"))),
        snapshot: Effect.fn("BoxdApi.snapshot")((name: string) =>
          call(machines, "snapshot", (opts) => client.getSnapshot({ name }, opts)).pipe(
            Effect.flatMap((value) =>
              decode(
                machines,
                BoxdSnapshot,
                "snapshot",
              )(
                value.snapshot === undefined
                  ? undefined
                  : { ...value.snapshot, memoryBytes: Number(value.snapshot.memoryBytes) },
              ),
            ),
          ),
        ),
        servedRegion: Option.match(cluster.region, {
          onNone: () => listRegions.pipe(Effect.map(({ thisRegion }) => thisRegion)),
          onSome: (configured) => Effect.succeed<string>(configured),
        }),
        createFromSnapshot: Effect.fn("BoxdApi.createFromSnapshot")((request: BoxdCreate) =>
          call(machines, "createFromSnapshot", (opts) =>
            client.createVmFromSnapshot(
              {
                snapshot: request.snapshot,
                name: request.name,
                // Machines keep the SSH setting they had before commands moved to `Exec`.
                config: { network: { ssh: true } },
                spec: {
                  version: 1,
                  isolated: request.isolated,
                  labels: request.labels,
                  egress: [...request.egress],
                },
              },
              opts,
            ),
          ).pipe(
            Effect.flatMap((value) =>
              decode(
                machines,
                BoxdCreated,
                "createFromSnapshot",
              )(
                value.machine === undefined
                  ? { id: value.vmId }
                  : { id: value.vmId, machine: machineValue(value.machine) },
              ),
            ),
          ),
        ),
        vm: Effect.fn("BoxdApi.vm")((id: MachineId) =>
          call(machines, "vm", (opts) => client.getVm({ vmId: id }, opts)).pipe(
            Effect.map(machineValue),
            Effect.flatMap(decode(machines, BoxdMachine, "vm")),
          ),
        ),
        listVms: Effect.fn("BoxdApi.listVms")((selector: ReadonlyArray<string>) =>
          list(selector).pipe(
            Effect.flatMap((value) =>
              decode(machines, Schema.Array(BoxdMachine), "listVms")(value.vms.map(machineValue)),
            ),
          ),
        ),
        updateLabels: Effect.fn("BoxdApi.updateLabels")(
          (id: MachineId, set: Record<string, string>) =>
            call(machines, "updateLabels", (opts) =>
              client.updateVmLabels({ vm: id, set }, opts),
            ).pipe(Effect.asVoid),
        ),
        destroy: Effect.fn("BoxdApi.destroy")((id: MachineId) =>
          call(machines, "destroy", (opts) => client.destroyVm({ vmId: id }, opts)).pipe(
            Effect.asVoid,
          ),
        ),
        setEgressAllow: Effect.fn("BoxdApi.setEgressAllow")(
          (id: MachineId, entries: ReadonlyArray<string>) =>
            call(machines, "setEgressAllow", (opts) =>
              client.setVmEgressAllow({ vm: id, entries: [...entries] }, opts),
            ).pipe(Effect.map(({ entries: inEffect }) => inEffect)),
        ),
        setAutoHibernateTimeout: Effect.fn("BoxdApi.setAutoHibernateTimeout")(
          (id: MachineId, seconds: number) =>
            call(machines, "setAutoHibernateTimeout", (opts) =>
              client.setAutoHibernateTimeout({ vmId: id, timeoutSecs: seconds }, opts),
            ).pipe(Effect.asVoid),
        ),
        setAutoSuspendTimeout: Effect.fn("BoxdApi.setAutoSuspendTimeout")(
          (id: MachineId, seconds: number) =>
            call(machines, "setAutoSuspendTimeout", (opts) =>
              client.setAutoSuspendTimeout({ vmId: id, timeoutSecs: seconds }, opts),
            ).pipe(Effect.asVoid),
        ),
      });
    }),
  );

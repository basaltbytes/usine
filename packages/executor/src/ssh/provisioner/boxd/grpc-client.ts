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
  BoxdCreated,
  BoxdIdentity,
  BoxdLimit,
  BoxdMachine,
  BoxdRegionList,
  BoxdSnapshot,
  BoxdUnknownRegion,
  type BoxdCreate,
} from "./client.ts";
import { failureCode } from "./status.ts";

class RpcRejection extends Schema.TaggedError<RpcRejection, { readonly brand: unique symbol }>()(
  "RpcRejection",
  { cause: Schema.Defect() },
) {}

/** The account endpoint, which also lists every region with its API endpoint. */
const BOXD_API = "https://boxd.sh:9443";
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
/** Returns `endpoint` as a URL, adding `https://` when boxd lists only the host and port. */
const endpointUrl = (endpoint: string): string =>
  /^[a-z][a-z0-9+.-]*:\/\//iu.test(endpoint) ? endpoint : `https://${endpoint}`;
const Session = Schema.Struct({ token: Schema.String, expires_at: Schema.Finite });
const machineValue = (value: GetVmResponse) => ({
  ...value,
  id: value.vmId,
  createdAt: Number(value.createdAt),
});
/**
 * Generated gRPC calls retain the serving-region metadata that the SDK omits.
 *
 * Building the layer exchanges the API key for a session and calls `ListRegions` on the account
 * endpoint to find the API endpoint of `region`. It fails with `BoxdUnknownRegion` when boxd lists
 * no such region with an API endpoint. When `endpoint` is set, it serves both account and
 * regional calls and the layer skips the lookup.
 *
 * A call that boxd refuses with `UNAUTHENTICATED` drops the session and runs once more with a new
 * one.
 */
export const boxdApiLayer = (
  token: Redacted.Redacted<string>,
  region: BoxdRegion,
  endpoint?: string,
  transport: typeof createGrpcTransport = createGrpcTransport,
): ReturnType<BoxdApiLayer> =>
  Layer.effect(
    BoxdApi,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const clientFor = (baseUrl: string) =>
        Effect.gen(function* () {
          const sessionManager = yield* Effect.acquireRelease(
            Effect.sync(() => new Http2SessionManager(baseUrl)),
            (manager) => Effect.sync(() => manager.abort()),
          );
          return createClient(
            BoxdService,
            transport({ baseUrl, sessionManager, defaultTimeoutMs: 30_000 }),
          );
        });
      const account = yield* clientFor(endpoint ?? BOXD_API);
      let session: Option.Option<typeof Session.Type> = Option.none();
      const exclusive = yield* Semaphore.make(1);
      const bearer = Effect.gen(function* () {
        const now = yield* DateTime.now;
        if (
          Option.isSome(session) &&
          session.value.expires_at > DateTime.toEpochMillis(now) / 1000 + REFRESH_MARGIN_SECONDS
        )
          return session.value.token;
        yield* Effect.logInfo("Exchanging boxd API key for a session", {
          region,
          refreshing: Option.isSome(session),
        });
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post("https://app.boxd.sh/api/v1/auth/token"),
          { api_key: Redacted.value(token) },
        );
        const response = yield* http.execute(request);
        if (response.status !== 200)
          return yield* BoxdCallError.make({
            operation: "authenticate",
            code: exchangeCode(response.status),
            message: `Token exchange returned HTTP ${response.status}`,
          });
        const decoded = yield* HttpClientResponse.schemaBodyJson(Session)(response);
        session = Option.some(decoded);
        return decoded.token;
      }).pipe(
        Effect.timeout("30 seconds"),
        exclusive.withPermit,
        Effect.catchTags({
          TimeoutError: () =>
            Effect.fail(
              BoxdCallError.make({
                operation: "authenticate",
                code: "UNAVAILABLE",
                message: "The boxd token exchange timed out",
              }),
            ),
          HttpClientError: () =>
            Effect.fail(
              BoxdCallError.make({
                operation: "authenticate",
                code: "UNAVAILABLE",
                message: "Could not reach the boxd token exchange",
              }),
            ),
          HttpBodyError: () =>
            Effect.fail(
              BoxdCallError.make({
                operation: "authenticate",
                code: "INTERNAL",
                message: "Could not encode the token request",
              }),
            ),
          SchemaError: () =>
            Effect.fail(
              BoxdCallError.make({
                operation: "authenticate",
                code: "INTERNAL",
                message: "Invalid token exchange response",
              }),
            ),
        }),
      );
      const invokeWith = <A>(
        operation: string,
        invoke: (options: CallOptions) => Promise<A>,
        jwt: string,
      ) =>
        Effect.tryPromise({
          try: (signal) => invoke({ signal, headers: { authorization: `Bearer ${jwt}` } }),
          catch: (cause) => RpcRejection.make({ cause }),
        }).pipe(
          Effect.catch((failure) =>
            failure.cause instanceof ConnectError
              ? Effect.fail(
                  BoxdCallError.make({
                    operation,
                    code: failureCode(failure.cause),
                    message: failure.cause.rawMessage
                      .replaceAll(Redacted.value(token), "[redacted]")
                      .replaceAll(jwt, "[redacted]"),
                  }),
                )
              : Effect.die(failure.cause),
          ),
        );
      const call = <A>(operation: string, invoke: (options: CallOptions) => Promise<A>) =>
        Effect.gen(function* () {
          const jwt = yield* bearer;
          return yield* invokeWith(operation, invoke, jwt).pipe(
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
                  return yield* invokeWith(operation, invoke, renewed);
                }),
            ),
          );
        }).pipe(Effect.withSpan(`BoxdApi.${operation}`));
      const decode =
        <S extends Schema.Top>(schema: S, operation: string) =>
        <A>(value: A) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(() =>
              BoxdCallError.make({
                operation,
                code: "INTERNAL",
                message: `Invalid ${operation} response`,
              }),
            ),
          );
      const listRegions = (client: typeof account) =>
        call("listRegions", (opts) => client.listRegions({}, opts)).pipe(
          Effect.flatMap(decode(BoxdRegionList, "listRegions")),
        );
      // The driver's boundary logs an unknown region once, with the worker.
      const regional = Effect.gen(function* () {
        const listed = yield* listRegions(account);
        const usable = listed.regions.filter(({ apiEndpoint }) => apiEndpoint.length > 0);
        const match = usable.find(({ id }) => id === region);
        if (match === undefined)
          return yield* BoxdUnknownRegion.make({ region, available: usable.map(({ id }) => id) });
        const url = endpointUrl(match.apiEndpoint);
        yield* Effect.logInfo("Resolved the boxd regional endpoint", { region, endpoint: url });
        return {
          url,
          client: url === BOXD_API ? account : yield* clientFor(url),
          servedRegion: Effect.succeed<string>(region),
        };
      }).pipe(Effect.withSpan("BoxdApi.resolveRegion", { attributes: { region } }));
      const overridden = (url: string) =>
        Effect.logInfo("Using the boxd endpoint override instead of listing regions", {
          region,
          endpoint: url,
        }).pipe(
          Effect.as({
            url,
            client: account,
            servedRegion: listRegions(account).pipe(Effect.map(({ thisRegion }) => thisRegion)),
          }),
        );
      const {
        url: regionalUrl,
        client,
        servedRegion,
      } = endpoint === undefined ? yield* regional : yield* overridden(endpoint);
      const list = (selector: ReadonlyArray<string>) =>
        call("listVms", (opts) => client.listVms({ labelSelector: [...selector] }, opts));
      return BoxdApi.of({
        endpoint: regionalUrl,
        whoami: call("whoami", (opts) => account.whoami({}, opts)).pipe(
          Effect.flatMap((value) => decode(BoxdIdentity, "whoami")({ userId: value.userId })),
        ),
        orgMachineLimit: call("orgMachineLimit", (opts) =>
          account.getOrgMachineLimit({}, opts),
        ).pipe(Effect.flatMap(decode(BoxdLimit, "orgMachineLimit"))),
        snapshot: Effect.fn("BoxdApi.snapshot")((name: string) =>
          call("snapshot", (opts) => client.getSnapshot({ name }, opts)).pipe(
            Effect.flatMap((value) =>
              decode(
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
        servedRegion,
        createFromSnapshot: Effect.fn("BoxdApi.createFromSnapshot")((request: BoxdCreate) =>
          call("createFromSnapshot", (opts) =>
            // Machines keep the SSH setting they had before commands moved to `Exec`.
            client.createVmFromSnapshot({ ...request, config: { network: { ssh: true } } }, opts),
          ).pipe(
            Effect.flatMap((value) =>
              decode(
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
          call("vm", (opts) => client.getVm({ vmId: id }, opts)).pipe(
            Effect.map(machineValue),
            Effect.flatMap(decode(BoxdMachine, "vm")),
          ),
        ),
        listVms: Effect.fn("BoxdApi.listVms")((selector: ReadonlyArray<string>) =>
          list(selector).pipe(
            Effect.flatMap((value) =>
              decode(Schema.Array(BoxdMachine), "listVms")(value.vms.map(machineValue)),
            ),
          ),
        ),
        updateLabels: Effect.fn("BoxdApi.updateLabels")(
          (id: MachineId, set: Record<string, string>) =>
            call("updateLabels", (opts) => client.updateVmLabels({ vm: id, set }, opts)).pipe(
              Effect.asVoid,
            ),
        ),
        destroy: Effect.fn("BoxdApi.destroy")((id: MachineId) =>
          call("destroy", (opts) => client.destroyVm({ vmId: id }, opts)).pipe(Effect.asVoid),
        ),
        setEgressAllow: Effect.fn("BoxdApi.setEgressAllow")(
          (id: MachineId, entries: ReadonlyArray<string>) =>
            call("setEgressAllow", (opts) =>
              client.setVmEgressAllow({ vm: id, entries: [...entries] }, opts),
            ).pipe(Effect.map(({ entries: inEffect }) => inEffect)),
        ),
        setAutoHibernateTimeout: Effect.fn("BoxdApi.setAutoHibernateTimeout")(
          (id: MachineId, seconds: number) =>
            call("setAutoHibernateTimeout", (opts) =>
              client.setAutoHibernateTimeout({ vmId: id, timeoutSecs: seconds }, opts),
            ).pipe(Effect.asVoid),
        ),
        setAutoSuspendTimeout: Effect.fn("BoxdApi.setAutoSuspendTimeout")(
          (id: MachineId, seconds: number) =>
            call("setAutoSuspendTimeout", (opts) =>
              client.setAutoSuspendTimeout({ vmId: id, timeoutSecs: seconds }, opts),
            ).pipe(Effect.asVoid),
        ),
      });
    }),
  );

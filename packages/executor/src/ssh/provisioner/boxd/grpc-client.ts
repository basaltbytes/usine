import { Code, ConnectError, createClient, type CallOptions } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { type MachineId, type BoxdRegion } from "@usine/core/worker";
import { DateTime, Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { BoxdApi as BoxdService, type GetVmResponse } from "./api-pb.ts";
import {
  BoxdApi,
  BoxdCallError,
  BoxdCreated,
  BoxdIdentity,
  BoxdLimit,
  BoxdMachine,
  BoxdRegions,
  BoxdSnapshot,
  BoxdUnknownRegion,
  type BoxdCreate,
} from "./client.ts";

class RpcRejection extends Schema.TaggedError<RpcRejection, { readonly brand: unique symbol }>()(
  "RpcRejection",
  { cause: Schema.Defect() },
) {}

/** The account endpoint, which also lists every region with its API endpoint. */
const BOXD_API = "https://boxd.sh:9443";
const RegionList = Schema.Struct({
  regions: Schema.Array(Schema.Struct({ id: Schema.String, apiEndpoint: Schema.String })),
});
/** Returns `endpoint` as a URL, adding `https://` when boxd lists only the host and port. */
const endpointUrl = (endpoint: string): string =>
  /^[a-z][a-z0-9+.-]*:\/\//iu.test(endpoint) ? endpoint : `https://${endpoint}`;
const Session = Schema.Struct({ token: Schema.String, expires_at: Schema.Finite });
const machineValue = (value: GetVmResponse) => ({
  ...value,
  id: value.vmId,
  createdAt: Number(value.createdAt),
});
const codeName = (code: Code): string =>
  (Code[code] ?? "Unknown")
    .replace(/[A-Z]/gu, (letter, index) => `${index === 0 ? "" : "_"}${letter}`)
    .toUpperCase();

export const failureCode = (failure: ConnectError): string => {
  if (!failure.isWireError && failure.code === Code.Canceled) return "UNAVAILABLE";
  const cause = failure.cause;
  return cause instanceof Error &&
    "code" in cause &&
    ["ECONNRESET", "ECONNABORTED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(
      String(cause.code),
    )
    ? "UNAVAILABLE"
    : codeName(failure.code);
};

/**
 * Generated gRPC calls retain proxy host keys and serving-region metadata omitted by the SDK.
 *
 * Building the layer exchanges the API key for a session and calls `ListRegions` on the account
 * endpoint to find the API endpoint of `region`. It fails with `BoxdUnknownRegion` when boxd lists
 * no such region. When `endpoint` is set, it serves both account and regional calls and the
 * layer skips the lookup.
 */
export const boxdApiLayer = (
  token: Redacted.Redacted<string>,
  region: BoxdRegion,
  endpoint?: string,
  transport: typeof createGrpcTransport = createGrpcTransport,
) =>
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
          session.value.expires_at > DateTime.toEpochMillis(now) / 1000 + 60
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
            code:
              response.status === 401
                ? "UNAUTHENTICATED"
                : response.status === 403
                  ? "PERMISSION_DENIED"
                  : response.status === 429
                    ? "RESOURCE_EXHAUSTED"
                    : "UNAVAILABLE",
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
      const call = <A>(operation: string, invoke: (options: CallOptions) => Promise<A>) =>
        Effect.gen(function* () {
          const jwt = yield* bearer;
          return yield* Effect.tryPromise({
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
      const regional = Effect.gen(function* () {
        const listed = yield* call("listRegions", (opts) => account.listRegions({}, opts)).pipe(
          Effect.flatMap(decode(RegionList, "listRegions")),
        );
        const match = listed.regions.find(({ id }) => id === region);
        if (match === undefined) {
          const available = listed.regions.map(({ id }) => id);
          yield* Effect.logWarning("boxd lists no region with the configured id", {
            region,
            available,
          });
          return yield* BoxdUnknownRegion.make({ region, available });
        }
        if (match.apiEndpoint.length === 0)
          return yield* BoxdCallError.make({
            operation: "listRegions",
            code: "INTERNAL",
            message: `boxd lists region ${region} without an API endpoint`,
          });
        const url = endpointUrl(match.apiEndpoint);
        yield* Effect.logInfo("Resolved the boxd regional endpoint", { region, endpoint: url });
        return url === BOXD_API ? account : yield* clientFor(url);
      }).pipe(Effect.withSpan("BoxdApi.resolveRegion", { attributes: { region } }));
      const client = endpoint === undefined ? yield* regional : account;
      const list = (selector: ReadonlyArray<string>) =>
        call("listVms", (opts) => client.listVms({ labelSelector: [...selector] }, opts));
      return BoxdApi.of({
        whoami: call("whoami", (opts) => account.whoami({}, opts)).pipe(
          Effect.flatMap((value) =>
            decode(
              BoxdIdentity,
              "whoami",
            )({ userId: value.userId, sshKeyFingerprints: value.pubkeyFingerprints }),
          ),
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
        regions: call("regions", (opts) => client.listRegions({}, opts)).pipe(
          Effect.flatMap(decode(BoxdRegions, "regions")),
        ),
        createFromSnapshot: Effect.fn("BoxdApi.createFromSnapshot")((request: BoxdCreate) =>
          call("createFromSnapshot", (opts) => client.createVmFromSnapshot(request, opts)).pipe(
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
        sshHostKey: list([]).pipe(
          Effect.flatMap((value) =>
            decode(
              Schema.NonEmptyString.check(
                Schema.isPattern(/^ssh-(?:ed25519|rsa) [A-Za-z0-9+/]+=*(?: .*)?$/u),
              ),
              "sshHostKey",
            )(value.sshHostKey),
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

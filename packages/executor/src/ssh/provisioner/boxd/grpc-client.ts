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
  type BoxdCreate,
} from "./client.ts";

class RpcRejection extends Schema.TaggedError<RpcRejection, { readonly brand: unique symbol }>()(
  "RpcRejection",
  { cause: Schema.Defect() },
) {}

const BOXD_API = "https://boxd.sh:9443";
const endpoints = { fra: BOXD_API, nyc: "https://nyc.boxd.sh:9443" } satisfies Record<
  BoxdRegion,
  string
>;
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

const failureCode = (failure: ConnectError): string => {
  const cause = failure.cause;
  return cause instanceof Error &&
    "code" in cause &&
    ["ECONNRESET", "ECONNABORTED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(
      String(cause.code),
    )
    ? "UNAVAILABLE"
    : codeName(failure.code);
};

/** Generated gRPC calls retain proxy host keys and serving-region metadata omitted by the SDK. */
export const boxdApiLayer = (
  token: Redacted.Redacted<string>,
  region: BoxdRegion,
  endpoint?: string,
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
            createGrpcTransport({ baseUrl, sessionManager, defaultTimeoutMs: 30_000 }),
          );
        });
      const client = yield* clientFor(endpoint ?? endpoints[region]);
      const account =
        endpoint === undefined && region !== "fra" ? yield* clientFor(BOXD_API) : client;
      let session: Option.Option<typeof Session.Type> = Option.none();
      const exclusive = yield* Semaphore.make(1);
      const bearer = Effect.gen(function* () {
        const now = yield* DateTime.now;
        if (
          Option.isSome(session) &&
          session.value.expires_at > DateTime.toEpochMillis(now) / 1000 + 60
        )
          return session.value.token;
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
        exclusive.withPermit,
        Effect.catchTags({
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
      const list = (selector: ReadonlyArray<string>) =>
        call("listVms", (opts) => client.listVms({ labelSelector: [...selector] }, opts));
      return BoxdApi.of({
        whoami: call("whoami", (opts) => account.whoami({}, opts)).pipe(
          Effect.flatMap(decode(BoxdIdentity, "whoami")),
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

import { catalog } from "@usine/agents/harness";
import type { GatewaySlot } from "@usine/core/agent/provider";
import type { GatewayCredentialKind, WorkerName } from "@usine/core/worker";
import { GatewayAdminPort } from "@usine/core/worker";
import type { RepositoryName } from "@usine/core/repository";
import { AnonymousCredential } from "@usine/gateway";
import { AttachRequest, CALLER_CREDENTIAL_HEADERS } from "@usine/gateway/admin";
import { Context, DateTime, Effect, Option, Ref, Schema, Semaphore, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { DEFAULT_SSH, remoteCommandsFor } from "../../remote/commands.ts";
import type { SshWorkerGateway } from "../model.ts";
import { gatewayAdminFor, type ProviderReport, reportedProviders } from "./admin.ts";
import { type GatewayLlmPrefixes, llmPrefixOf } from "./environment.ts";
import { gatewayForwardFor } from "./forward.ts";

/** A gateway model route that could not be checked or used. Contains no credentials. */
export class GatewayModelError extends Schema.TaggedError<
  GatewayModelError,
  { readonly brand: unique symbol }
>("@usine/executor/GatewayModelError")("GatewayModelError", { message: Schema.NonEmptyString }) {}

/** Model access for runtimes on the orchestrator, including the coordinator and supervisor. */
export interface GatewayModelRoute {
  /** Returns the kind of credential that the gateway holds for `slot`, or `None` for none. */
  readonly credential: (
    slot: GatewaySlot,
  ) => Effect.Effect<Option.Option<GatewayCredentialKind>, GatewayModelError>;
  /** Posts `body` to `path` under `slot`, such as `/v1/messages` under `anthropic-messages`. */
  readonly request: (
    slot: GatewaySlot,
    path: string,
    body: string,
    headers: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) => Effect.Effect<Response, GatewayModelError>;
}

/** Opens SSH forwards and a renewable anonymous attachment, and detaches it when the scope closes. */
export const gatewayModelRouteFor = Effect.fn("GatewayModelRoute.open")(
  function* (worker: WorkerName, repository: RepositoryName, gateway: SshWorkerGateway) {
    yield* Effect.annotateCurrentSpan({ worker, gateway: gateway.destination });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const commands = yield* remoteCommandsFor;
    const shell = commands.shellFor(DEFAULT_SSH, gateway.destination);
    const adminForward = yield* gatewayForwardFor(
      spawner,
      shell,
      gateway.destination,
      gateway.adminPort,
    );
    const admin = yield* gatewayAdminFor(worker, gateway, adminForward);
    const modelForward = yield* gatewayForwardFor(
      spawner,
      shell,
      gateway.destination,
      GatewayAdminPort.make(80),
    );
    const http = yield* HttpClient.HttpClient;
    const opened = yield* modelForward.current.pipe(
      Effect.catchTag("GatewayForwardClosed", (error) => modelForward.reopen(error.generation)),
    );
    const probe = yield* http
      .get(new URL("/", opened.url), {
        headers: { host: `llm.${gateway.domain}` },
      })
      .pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            GatewayModelError.make({
              message: `The model proxy on gateway ${gateway.destination} did not answer within 30 seconds.`,
            }),
        }),
      );
    if (
      probe.status !== 401 ||
      probe.headers["x-usine-gateway-refusal"] !== "missing-caller-token"
    ) {
      return yield* GatewayModelError.make({
        message: `The coordinator can't reach the model proxy on gateway ${gateway.destination}.`,
      });
    }
    const providers = catalog.providers;
    const prefixes = yield* Ref.make<GatewayLlmPrefixes>("slot");
    /** Sends later requests to the path prefixes that `report` shows, and logs each change. */
    const recordPrefixes = Effect.fn("GatewayModelRoute.recordPrefixes")(function* (
      report: Option.Option<ProviderReport>,
    ) {
      // A Gateway that predates the provider report also predates protocol path prefixes.
      const next = Option.match(report, {
        onNone: (): GatewayLlmPrefixes => "provider",
        onSome: (value) => reportedProviders(providers, value).prefixes,
      });
      const fields = { worker, gateway: gateway.destination, llmPrefixes: next };
      yield* Effect.annotateCurrentSpan(fields);
      const previous = yield* Ref.getAndSet(prefixes, next);
      if (previous === next) return;
      if (next === "provider")
        return yield* Effect.logWarning(
          "The gateway predates protocol path prefixes; the orchestrator model route uses its provider prefixes until @usine/gateway is upgraded on it",
          fields,
        );
      yield* Effect.logInfo(
        "The gateway serves protocol path prefixes; the orchestrator model route uses them",
        fields,
      );
    });
    const readProviders = Effect.tap(admin.providers, recordPrefixes);
    yield* readProviders;

    const failed = (message: string) => GatewayModelError.make({ message });
    const requestFor = Effect.map(DateTime.now, (now) =>
      AttachRequest.make({
        worker,
        repository,
        credential: AnonymousCredential.make(),
        expiresAt: DateTime.add(now, { hours: 1 }),
      }),
    );
    const turn = yield* Semaphore.make(1);
    const attached = yield* Effect.acquireRelease(
      Effect.flatMap(requestFor, admin.attach),
      ({ attachment }) =>
        admin.detach(attachment.id).pipe(
          Effect.tapError((error) =>
            Effect.logWarning(
              "Could not detach the orchestrator model route; it expires in one hour",
              {
                worker,
                message: error.message,
              },
            ),
          ),
          Effect.ignore,
          turn.withPermits(1),
        ),
    );
    yield* Effect.forever(
      Effect.sleep("2 minutes").pipe(
        Effect.andThen(
          Effect.flatMap(requestFor, (request) =>
            admin.renew(attached.attachment.id, request),
          ).pipe(turn.withPermits(1), Effect.uninterruptible),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Could not renew the orchestrator model route; will retry", {
            worker,
            message: error.message,
          }),
        ),
        Effect.ignore,
        Effect.andThen(
          readProviders.pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "Could not read the gateway's provider report; the orchestrator model route keeps its path prefixes",
                { worker, message: error.message },
              ),
            ),
            Effect.ignore,
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
    const credential = Effect.fn("GatewayModelRoute.credential")(function* (slot: GatewaySlot) {
      yield* Effect.annotateCurrentSpan({ worker, slot });
      const report = yield* readProviders;
      if (Option.isNone(report))
        return yield* failed(
          "Upgrade @usine/gateway: the coordinator requires gateway credential reporting.",
        );
      return Option.fromUndefinedOr(reportedProviders(providers, report.value).credentials[slot]);
    });
    /** Returns the `llm.<domain>` path prefix of `slot` on the Gateway. */
    const prefixOf = (slot: GatewaySlot, current: GatewayLlmPrefixes) =>
      Option.match(providers.find(slot), {
        onNone: () => slot,
        onSome: (provider) => llmPrefixOf(provider, current),
      });
    const request = Effect.fn("GatewayModelRoute.request")(function* (
      slot: GatewaySlot,
      path: string,
      body: string,
      headers: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, slot, path });
      const forward = yield* modelForward.current.pipe(
        Effect.catchTag("GatewayForwardClosed", (error) => modelForward.reopen(error.generation)),
      );
      const current = yield* Ref.get(prefixes);
      const response = yield* http.execute(
        HttpClientRequest.post(new URL(`/${prefixOf(slot, current)}${path}`, forward.url)).pipe(
          HttpClientRequest.setHeaders(headers),
          // The gateway reads its own token header before Authorization, so no caller header stays.
          (request) =>
            CALLER_CREDENTIAL_HEADERS.reduce(
              (remaining, name) => HttpClientRequest.removeHeader(remaining, name),
              request,
            ),
          HttpClientRequest.removeHeader("chatgpt-account-id"),
          HttpClientRequest.setHeader("host", `llm.${gateway.domain}`),
          HttpClientRequest.bearerToken(attached.callerToken),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      );
      return new Response(
        Stream.toReadableStreamWith(response.stream, Context.empty(), { signal }),
        {
          status: response.status,
          headers: response.headers,
        },
      );
    });
    const opening = yield* Ref.get(prefixes);
    yield* Effect.logInfo("Opened the orchestrator gateway model route", {
      worker,
      gateway: gateway.destination,
      llmPrefixes: opening,
    });
    const route: GatewayModelRoute = {
      credential: (slot) =>
        credential(slot).pipe(
          Effect.mapError((error) =>
            error._tag === "GatewayModelError"
              ? error
              : failed(`Can't check gateway credential for ${slot} at ${gateway.destination}.`),
          ),
        ),
      request: (slot, path, body, headers, signal) =>
        request(slot, path, body, headers, signal).pipe(
          Effect.mapError(() =>
            failed(`Can't call ${slot}${path} through gateway ${gateway.destination}.`),
          ),
        ),
    };
    return route;
  },
  Effect.mapError((error) =>
    error._tag === "GatewayModelError"
      ? error
      : GatewayModelError.make({
          message:
            error._tag === "GatewayAdminError"
              ? error.message
              : error._tag === "GatewayForwardClosed"
                ? `Can't reach gateway ${error.gateway}: ${error.reason}.`
                : `Can't open the orchestrator gateway model route (${error._tag}).`,
        }),
  ),
);

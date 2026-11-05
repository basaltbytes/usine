import type { GatewayCredentialKind, GatewayLlmProtocol, WorkerName } from "@usine/core/worker";
import { GatewayAdminPort } from "@usine/core/worker";
import type { RepositoryName } from "@usine/core/repository";
import { AnonymousCredential } from "@usine/gateway";
import { AttachRequest } from "@usine/gateway/admin";
import { Context, DateTime, Effect, Option, Schema, Semaphore, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { DEFAULT_SSH, remoteCommandsFor } from "../../remote/commands.ts";
import type { SshWorkerGateway } from "../model.ts";
import { gatewayAdminFor } from "./admin.ts";
import { gatewayForwardFor } from "./forward.ts";

/** A gateway model route that could not be checked or used. Contains no credentials. */
export class GatewayModelError extends Schema.TaggedError<
  GatewayModelError,
  { readonly brand: unique symbol }
>("@usine/executor/GatewayModelError")("GatewayModelError", { message: Schema.NonEmptyString }) {}

/** Model access for runtimes on the orchestrator, including the coordinator and supervisor. */
export interface GatewayModelRoute {
  readonly credential: (
    protocol: GatewayLlmProtocol,
  ) => Effect.Effect<Option.Option<GatewayCredentialKind>, GatewayModelError>;
  readonly request: (
    protocol: GatewayLlmProtocol,
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
      .get(new URL("/openai-responses/v1/models", opened.url), {
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
      ),
    ).pipe(Effect.forkScoped);
    const credential = Effect.fn("GatewayModelRoute.credential")(function* (
      protocol: GatewayLlmProtocol,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, protocol });
      const listed = yield* admin.providers;
      if (Option.isNone(listed))
        return yield* failed(
          "Upgrade @usine/gateway: the coordinator requires gateway credential reporting.",
        );
      return Option.fromUndefinedOr(
        listed.value.providers.find(({ provider }) => provider === protocol)?.credential,
      );
    });
    const request = Effect.fn("GatewayModelRoute.request")(function* (
      protocol: GatewayLlmProtocol,
      body: string,
      headers: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ) {
      yield* Effect.annotateCurrentSpan({ worker, protocol });
      const forward = yield* modelForward.current.pipe(
        Effect.catchTag("GatewayForwardClosed", (error) => modelForward.reopen(error.generation)),
      );
      const path = protocol === "openai-responses" ? "responses" : "messages";
      const response = yield* http.execute(
        HttpClientRequest.post(new URL(`/${protocol}/v1/${path}`, forward.url)).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.removeHeader("x-api-key"),
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
    yield* Effect.logInfo("Opened the orchestrator gateway model route", {
      worker,
      gateway: gateway.destination,
    });
    const route: GatewayModelRoute = {
      credential: (protocol) =>
        credential(protocol).pipe(
          Effect.mapError((error) =>
            error._tag === "GatewayModelError"
              ? error
              : failed(`Can't check gateway credential for ${protocol} at ${gateway.destination}.`),
          ),
        ),
      request: (protocol, body, headers, signal) =>
        request(protocol, body, headers, signal).pipe(
          Effect.mapError(() =>
            failed(`Can't call ${protocol} through gateway ${gateway.destination}.`),
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

import { RequestPermissions } from "@usine/core/access";
import { Cause, Clock, Deferred, Duration, Effect, Layer, Option, RcMap, Schema } from "effect";
import { McpServer } from "effect/ai";
import {
  HttpEffect,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { RequestCredential, RequestCsrf, RequestOperations } from "../auth/http.ts";
import { packageVersion } from "../cli.ts";
import { operatorOpenApi } from "../openapi.ts";
import {
  MCP_PROTOCOLS,
  type OperatorCall,
  OperatorUnavailableError,
  registerOperatorTools,
} from "./server.ts";
import { type EndingSession, SessionAdmission, SessionEnd, sessionTable } from "./sessions.ts";
import {
  loadOperatorTools,
  type OperatorRequest,
  type OperatorResponse,
  type OperatorTool,
  PublishedApi,
  visibleTools,
} from "./tools.ts";

/** The path of the Streamable HTTP MCP endpoint. */
export const MCP_PATH = "/api/mcp";
// The credential headers that an in-process operator request carries from the MCP request.
const CREDENTIAL_HEADERS = ["authorization", "cookie", "x-usine-csrf"] as const;
const JsonBody = Schema.fromJsonString(Schema.Json);
const credentialHeaders = (request: HttpServerRequest.HttpServerRequest) => {
  const headers = new Headers();
  for (const name of CREDENTIAL_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers.set(name, value);
  }
  return headers;
};
const SESSION_HEADER = "mcp-session-id";
/** How long an MCP session can go unused before the server ends it. */
export const MCP_SESSION_IDLE = Duration.hours(1);
const SESSION_RETRY = "MCP tool server did not end the session; the next sweep retries";

/**
 * Sends each operator request through `router` in this process, with the `credential` headers, so
 * the route policy, the auth guard, and audit apply to it as to an HTTP request.
 */
export const routedOperatorCall = (
  router: HttpRouter.HttpRouter,
  credential: Readonly<Record<string, string>>,
) =>
  Effect.fn("Operator.routedRequest")(function* (request: OperatorRequest) {
    yield* Effect.annotateCurrentSpan({ method: request.method, url: request.url });
    const headers = new Headers(credential);
    const body = yield* Effect.transposeOption(
      Option.map(request.body, (value) => Schema.encodeEffect(JsonBody)(value)),
    ).pipe(Effect.orDie);
    if (Option.isSome(body)) headers.set("content-type", "application/json");
    const inner = HttpServerRequest.fromWeb(
      new Request(new URL(request.url, "http://localhost"), {
        method: request.method,
        headers,
        ...Option.match(body, { onNone: () => ({}), onSome: (text) => ({ body: text }) }),
      }),
    );
    const sent = yield* Deferred.make<OperatorResponse>();
    // The router erases its routes' error types; causeResponse maps each to its response.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    const routed = router
      .asHttpEffect()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.map(HttpServerError.causeResponse(cause), ([response]) => response),
        ),
      );
    yield* HttpEffect.toHandled(routed, (_, response) =>
      Effect.promise(() => HttpServerResponse.toWeb(response).text()).pipe(
        Effect.flatMap((text) => Deferred.succeed(sent, { status: response.status, text })),
      ),
    ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, inner));
    return yield* Deferred.await(sent);
  });

/**
 * Serves the operator tools at `POST /api/mcp`. Each tool call goes through the same router as an
 * HTTP request with the caller's credential, so the route policy, the auth guard, and audit apply
 * to it unchanged. Install the auth guard on this route.
 *
 * A session answers only the credential that opened it, and ends after `MCP_SESSION_IDLE` without
 * a request. Other requests for it get HTTP 404, so the client starts a new session.
 */
export const mcpRoutes = (allowedOrigins: ReadonlyArray<string>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const version = yield* packageVersion().pipe(
        Effect.tapError((error) =>
          Effect.logWarning("MCP server version unavailable", { error: error._tag }),
        ),
        Effect.orElseSucceed(() => "unknown"),
      );
      const document = yield* Schema.decodeUnknownEffect(PublishedApi)(operatorOpenApi()).pipe(
        Effect.orDie,
      );
      const tools = yield* loadOperatorTools(document);
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const call: OperatorCall = Effect.fn("Mcp.operatorRequest")(function* (request) {
        const caller = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
        if (Option.isNone(caller))
          return yield* OperatorUnavailableError.make({
            message: "The MCP request has no HTTP request to take the credential from.",
          });
        return yield* routedOperatorCall(
          router,
          Object.fromEntries(credentialHeaders(caller.value)),
        )(request);
      });
      // One MCP server per set of visible tools: the protocol lists one set per server, and a
      // client's session stays on the server of its token's grants.
      const servers = yield* RcMap.make({
        lookup: (key: string) =>
          Effect.gen(function* () {
            const visible =
              key === ""
                ? []
                : key.split(",").flatMap((name) => {
                    const tool = byName.get(name);
                    return tool === undefined ? [] : [tool];
                  });
            yield* Effect.logInfo("MCP tool server started", { tools: visible.length });
            // A fresh memo map gives the server its own router instead of the enclosing one.
            const memoMap = yield* Layer.makeMemoMap;
            return yield* HttpRouter.toHttpEffect(
              Layer.effectDiscard(registerOperatorTools(visible, call)).pipe(
                Layer.provideMerge(
                  McpServer.layerHttp({
                    name: "usine",
                    version,
                    path: MCP_PATH,
                    protocols: MCP_PROTOCOLS,
                    allowedOrigins,
                    allowSessionTermination: true,
                  }),
                ),
              ),
            ).pipe(Effect.provideService(Layer.CurrentMemoMap, memoMap), Effect.orDie);
          }),
        idleTimeToLive: "1 hour",
      });
      const sessions = sessionTable(Duration.toMillis(MCP_SESSION_IDLE));
      // Ends the session on its tool server, which keeps it until a DELETE. The auth guard also
      // covers the tool server's routes, so the DELETE carries the credential of `caller`, with
      // the CSRF token that a cookie `GET` doesn't send.
      const endSession = Effect.fn("Mcp.endSession")(function* (
        caller: HttpServerRequest.HttpServerRequest,
        csrf: Option.Option<string>,
        ending: EndingSession,
      ) {
        const { id, session, reason } = ending;
        // A released tool server took its sessions with it.
        const server = yield* RcMap.getOption(servers, session.tools);
        if (Option.isNone(server)) {
          yield* Effect.logInfo("MCP session ended with its tool server", { reason });
          return;
        }
        const headers = credentialHeaders(caller);
        if (Option.isSome(csrf)) headers.set("x-usine-csrf", csrf.value);
        headers.set(SESSION_HEADER, id);
        const ended = yield* server.value.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(new URL(MCP_PATH, "http://localhost"), { method: "DELETE", headers }),
            ),
          ),
        );
        yield* SessionEnd.$match(sessions.settle(ending, ended.status), {
          Ended: () => Effect.logInfo("MCP session ended", { reason }),
          Gone: () => Effect.logInfo("MCP session already ended on its tool server", { reason }),
          Refused: () => Effect.logWarning(SESSION_RETRY, { reason, status: ended.status }),
        });
      }, Effect.scoped);
      // Ends the sessions that `takeStale` returns. A session whose end fails, or that the request
      // didn't reach because its client went away, goes back to the table for the next sweep.
      const sweep = Effect.fn("Mcp.sweep")(function* (
        caller: HttpServerRequest.HttpServerRequest,
        csrf: Option.Option<string>,
        now: number,
      ) {
        const unsettled = new Set<EndingSession>();
        yield* Effect.suspend(() => {
          const endings = sessions.takeStale(now);
          for (const ending of endings) unsettled.add(ending);
          return Effect.forEach(
            endings,
            (ending) =>
              endSession(caller, csrf, ending).pipe(
                Effect.matchCauseEffect({
                  onSuccess: () => Effect.sync(() => unsettled.delete(ending)),
                  onFailure: (cause) =>
                    Effect.logWarning(SESSION_RETRY, {
                      reason: ending.reason,
                      cause: Cause.pretty(cause),
                    }),
                }),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.onExit(() =>
            Effect.suspend(() => {
              if (unsettled.size === 0) return Effect.void;
              const reasons = new Set<EndingSession["reason"]>();
              for (const ending of unsettled) {
                sessions.retry(ending);
                reasons.add(ending.reason);
              }
              return Effect.logInfo("MCP sweep handed sessions back for the next sweep", {
                sessions: unsettled.size,
                reasons: [...reasons].join(", "),
              });
            }),
          ),
        );
      });
      const notFound = HttpServerResponse.empty({ status: 404 });
      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const credential = yield* RequestCredential;
        if (Option.isNone(credential))
          return yield* Effect.die("The MCP route runs without the auth guard.");
        const csrf = yield* RequestCsrf;
        const now = yield* Clock.currentTimeMillis;
        yield* sweep(request, csrf, now);
        const grants = yield* RequestPermissions;
        const ceiling = yield* RequestOperations;
        const visible: ReadonlyArray<OperatorTool> = visibleTools(tools, grants, ceiling);
        const key = visible.map(({ name }) => name).join(",");
        const id = request.headers[SESSION_HEADER];
        if (id !== undefined) {
          const refusal = yield* SessionAdmission.$match(
            sessions.admit(id, credential.value, key, now),
            {
              Admitted: () => Effect.succeedNone,
              Unknown: () =>
                Effect.logInfo("MCP request refused: the session is unknown or ended").pipe(
                  Effect.as(Option.some(notFound)),
                ),
              OtherCredential: () =>
                Effect.logWarning(
                  "MCP request refused: the session belongs to another credential",
                ).pipe(Effect.as(Option.some(notFound))),
              ToolsChanged: () => sweep(request, csrf, now).pipe(Effect.as(Option.some(notFound))),
            },
          );
          if (Option.isSome(refusal)) return refusal.value;
        }
        const server = yield* RcMap.get(servers, key);
        const response = yield* server;
        if (id !== undefined && request.method === "DELETE")
          yield* SessionEnd.$match(sessions.close(id, response.status), {
            Ended: () => Effect.logInfo("MCP session ended", { reason: "client" }),
            Gone: () =>
              Effect.logInfo("MCP session already ended on its tool server", { reason: "client" }),
            Refused: () =>
              Effect.logInfo(
                "MCP tool server refused the client's DELETE; the session stays open",
                {
                  status: response.status,
                },
              ),
          });
        // The MCP server sets the header of a new session just before the response is sent.
        if (id === undefined)
          yield* HttpEffect.appendPreResponseHandler((_, sent) => {
            const opened = sent.headers[SESSION_HEADER];
            if (opened !== undefined)
              sessions.open(opened, { credential: credential.value, tools: key, lastUsedAt: now });
            return Effect.succeed(sent);
          });
        return response;
      });
      yield* router.add("*", MCP_PATH, handler);
    }),
  );

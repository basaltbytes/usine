import { RequestPermissions } from "@usine/core/access";
import { Deferred, Effect, Layer, Option, RcMap, Schema } from "effect";
import { McpServer } from "effect/ai";
import {
  HttpEffect,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { RequestOperations } from "../auth/http.ts";
import { packageVersion } from "../cli.ts";
import { operatorOpenApi } from "../openapi.ts";
import {
  MCP_PROTOCOLS,
  type OperatorCall,
  OperatorUnavailableError,
  registerOperatorTools,
} from "./server.ts";
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
        const credential: Record<string, string> = {};
        for (const name of CREDENTIAL_HEADERS) {
          const value = caller.value.headers[name];
          if (value !== undefined) credential[name] = value;
        }
        return yield* routedOperatorCall(router, credential)(request);
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
      const handler = Effect.gen(function* () {
        const grants = yield* RequestPermissions;
        const ceiling = yield* RequestOperations;
        const visible: ReadonlyArray<OperatorTool> = visibleTools(tools, grants, ceiling);
        const server = yield* RcMap.get(servers, visible.map(({ name }) => name).join(","));
        return yield* server;
      });
      yield* router.add("*", MCP_PATH, handler);
    }),
  );

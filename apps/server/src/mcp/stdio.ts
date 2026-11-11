import { PermissionGrant } from "@usine/core/access";
import { type Brand, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { McpServer } from "effect/ai";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { OperationId } from "../auth/model.ts";
import { packageVersion } from "../cli.ts";
import {
  MCP_PROTOCOLS,
  type OperatorCall,
  OperatorUnavailableError,
  registerOperatorTools,
} from "./server.ts";
import { operatorTools, PublishedApi, visibleTools } from "./tools.ts";

const REQUEST_TIMEOUT = Duration.seconds(30);

/** `usine mcp` could not read the instance's API document or the token's session. */
export class McpStartError extends Schema.TaggedError<
  McpStartError,
  Brand.Brand<"@usine/server/mcp/stdio/McpStartError">
>()("McpStartError", { message: Schema.String }) {}

const Session = Schema.Struct({
  permissions: Schema.Array(PermissionGrant),
  operations: Schema.optionalKey(Schema.Array(OperationId)),
});

/**
 * Serves the operator tools of the instance at `origin` over standard input and output. It reads
 * the instance's OpenAPI document and the token's session once, at start, and sends every tool call
 * to the instance with `token`.
 */
export const stdioServer = (origin: string, token: Redacted.Redacted<string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(token))),
      );
      const failure =
        (path: string) => (error: { readonly _tag: string; readonly message: string }) =>
          Effect.logWarning("MCP start request failed", { path, error: error._tag }).pipe(
            Effect.andThen(
              McpStartError.make({
                message: `Could not read ${new URL(path, origin).href} (${error.message}). Check that usine runs at ${origin}.`,
              }),
            ),
          );
      const get = Effect.fn("Mcp.readInstance")(function* (path: string) {
        yield* Effect.annotateCurrentSpan({ origin, path });
        const response = yield* client
          .get(new URL(path, origin))
          .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.catch(failure(path)));
        if (response.status === 401 || response.status === 403)
          return yield* McpStartError.make({
            message: `${origin} refused the token (HTTP ${response.status}). Set USINE_TOKEN to an instance token from usine sign-in, or check its scopes.`,
          });
        return yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Json)),
          Effect.catch(failure(path)),
        );
      });
      const decode = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
        get(path).pipe(
          Effect.flatMap((body) =>
            Schema.decodeUnknownEffect(schema)(body).pipe(Effect.catch(failure(path))),
          ),
        );
      const document = yield* decode("/api/openapi.json", PublishedApi);
      const session = yield* decode("/api/auth/session", Session);
      const tools = visibleTools(
        operatorTools(document),
        session.permissions,
        Option.fromUndefinedOr(session.operations),
      );
      const call: OperatorCall = Effect.fn("Mcp.remoteOperatorRequest")(function* (request) {
        yield* Effect.annotateCurrentSpan({ method: request.method, url: request.url });
        const outgoing = HttpClientRequest.make(request.method)(new URL(request.url, origin));
        const response = yield* client
          .execute(
            Option.match(request.body, {
              onNone: () => outgoing,
              onSome: (body) => HttpClientRequest.bodyJsonUnsafe(outgoing, body),
            }),
          )
          .pipe(
            Effect.flatMap((response) =>
              Effect.map(response.text, (text) => ({ status: response.status, text })),
            ),
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError((error) =>
              OperatorUnavailableError.make({
                message: `Could not reach ${origin} (${error.message}).`,
              }),
            ),
          );
        return response;
      });
      const version = yield* packageVersion().pipe(
        Effect.tapError((error) =>
          Effect.logWarning("MCP server version unavailable", { error: error._tag }),
        ),
        Effect.orElseSucceed(() => "unknown"),
      );
      yield* Effect.logInfo("MCP tools ready on standard input and output", {
        origin,
        tools: tools.length,
      });
      return Layer.effectDiscard(registerOperatorTools(tools, call)).pipe(
        Layer.provideMerge(
          // The protocol list is fixed, so a refused list is a defect.
          McpServer.layerStdio({ name: "usine", version, protocols: MCP_PROTOCOLS }).pipe(
            Layer.orDie,
          ),
        ),
      );
    }),
  );

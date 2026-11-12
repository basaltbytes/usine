import { PermissionGrant } from "@usine/core/access";
import { type Brand, Duration, Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
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
import { loadOperatorTools, PublishedApi, visibleTools } from "./tools.ts";

const REQUEST_TIMEOUT = Duration.seconds(30);
/** The largest response, in bytes, that `usine mcp` reads from the instance at start. */
export const MAX_START_RESPONSE_BYTES = 8 * 1024 * 1024;
const JsonText = Schema.fromJsonString(Schema.Json);
const decoder = new TextDecoder();

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
 * to the instance with `token`. Each request to the instance fails after `requestTimeout`.
 */
export const stdioServer = (
  origin: string,
  token: Redacted.Redacted<string>,
  requestTimeout: Duration.Input = REQUEST_TIMEOUT,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const instance = new URL(origin);
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
        const url = new URL(path, origin);
        const response = yield* client
          .get(url)
          .pipe(Effect.timeout(requestTimeout), Effect.catch(failure(path)));
        if (response.status === 401 || response.status === 403)
          return yield* McpStartError.make({
            message: `${origin} refused the token (HTTP ${response.status}). Set USINE_TOKEN to an instance token from usine sign-in, or check its scopes.`,
          });
        const ok = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.catch(failure(path)),
        );
        const body = yield* ok.stream.pipe(
          Stream.runFoldEffect(
            () => ({ size: 0, chunks: new Array<Uint8Array>() }),
            (read, chunk) => {
              const size = read.size + chunk.length;
              if (size <= MAX_START_RESPONSE_BYTES) {
                read.chunks.push(chunk);
                return Effect.succeed({ size, chunks: read.chunks });
              }
              return Effect.logWarning("MCP start response refused: too large", {
                path,
                limit: MAX_START_RESPONSE_BYTES,
              }).pipe(
                Effect.andThen(
                  McpStartError.make({
                    message: `${url.href} returned more than ${MAX_START_RESPONSE_BYTES} bytes. Check that usine runs at ${origin}.`,
                  }),
                ),
              );
            },
          ),
          Effect.timeout(requestTimeout),
          Effect.catchTags({ HttpClientError: failure(path), TimeoutError: failure(path) }),
        );
        const bytes = new Uint8Array(body.size);
        let offset = 0;
        for (const chunk of body.chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return yield* Schema.decodeEffect(JsonText)(decoder.decode(bytes)).pipe(
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
      const generated = yield* loadOperatorTools(document, { origin });
      const tools = visibleTools(
        generated,
        session.permissions,
        Option.fromUndefinedOr(session.operations),
      );
      const call: OperatorCall = Effect.fn("Mcp.remoteOperatorRequest")(function* (request) {
        yield* Effect.annotateCurrentSpan({ method: request.method, url: request.url });
        const url = new URL(request.url, origin);
        // A path key of the instance's document, such as `//other.example/x`, can name another
        // host; the token goes only to `origin`.
        if (url.origin !== instance.origin) {
          yield* Effect.logWarning("MCP tool call refused: its URL leaves the instance origin", {
            origin,
            target: url.origin,
          });
          return yield* OperatorUnavailableError.make({
            message: `Refused to send the token to ${url.origin}: the tool's path leaves ${origin}.`,
          });
        }
        const outgoing = HttpClientRequest.make(request.method)(url);
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
            Effect.timeout(requestTimeout),
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

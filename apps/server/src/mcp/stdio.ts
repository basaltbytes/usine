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
/** The deepest nesting of arrays and objects that `usine mcp` accepts in a start response. */
export const MAX_START_NESTING = 256;
/** The most arrays and objects that `usine mcp` accepts in a start response. */
export const MAX_START_CONTAINERS = 200_000;
const decoder = new TextDecoder();

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

/**
 * The deepest nesting and the number of arrays and objects in the JSON text `bytes`, counted
 * outside strings. A UTF-8 byte below 0x80 is always a whole character, so the scan reads bytes.
 */
const measureJson = (bytes: Uint8Array) => {
  let depth = 0;
  let deepest = 0;
  let containers = 0;
  let inString = false;
  let escaped = false;
  for (const byte of bytes) {
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === BACKSLASH) escaped = true;
      else if (byte === QUOTE) inString = false;
    } else if (byte === QUOTE) inString = true;
    else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      depth += 1;
      containers += 1;
      if (depth > deepest) deepest = depth;
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) depth -= 1;
  }
  return { deepest, containers };
};

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
      const refuse = (path: string, reason: string, limit: number, message: string) =>
        Effect.logWarning(`MCP start response refused: ${reason}`, { path, limit }).pipe(
          Effect.andThen(
            McpStartError.make({
              message: `${new URL(path, origin).href} ${message}. Check that usine runs at ${origin}.`,
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
              return refuse(
                path,
                "too large",
                MAX_START_RESPONSE_BYTES,
                `returned more than ${MAX_START_RESPONSE_BYTES} bytes`,
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
        // Decoding walks every array and object, and its time grows faster than their number and
        // depth, so a start response must fit both limits before it is decoded.
        const { deepest, containers } = measureJson(bytes);
        if (deepest > MAX_START_NESTING)
          return yield* refuse(
            path,
            "nested too deeply",
            MAX_START_NESTING,
            `nests arrays and objects more than ${MAX_START_NESTING} levels deep`,
          );
        if (containers > MAX_START_CONTAINERS)
          return yield* refuse(
            path,
            "too many values",
            MAX_START_CONTAINERS,
            `holds more than ${MAX_START_CONTAINERS} arrays and objects`,
          );
        return decoder.decode(bytes);
      });
      // One decode from the text, so the document is walked once.
      const decode = <A, I>(path: string, schema: Schema.Codec<A, I>) =>
        get(path).pipe(
          Effect.flatMap((text) =>
            Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
              Effect.catch(failure(path)),
            ),
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

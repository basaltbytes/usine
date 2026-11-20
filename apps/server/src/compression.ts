import { brotliCompress, constants, gzip } from "node:zlib";
import { type Brand, Effect, Option, Schema } from "effect";
import {
  HttpBody,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Mime,
} from "effect/http";

/** The encodings the server sends, in its order of preference. */
const ENCODINGS = ["br", "gzip"] as const;
type Encoding = (typeof ENCODINGS)[number];

/** The file extension of a precompressed build file, by encoding. */
const EXTENSIONS = { br: ".br", gzip: ".gz" } satisfies Record<Encoding, string>;

/** The smallest body, in bytes, that the server compresses. */
const MIN_BYTES = 1024;

const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 6;

class CompressionError extends Schema.TaggedError<
  CompressionError,
  Brand.Brand<"@usine/server/compression/CompressionError">
>("@usine/server/CompressionError")("CompressionError", {
  encoding: Schema.Literals(ENCODINGS),
  cause: Schema.Defect(),
}) {}

/** Returns the encodings that `header` accepts, the most preferred first. */
const acceptedEncodings = (header: string | undefined): ReadonlyArray<Encoding> => {
  const weights = new Map<string, number>();
  for (const part of header?.split(",") ?? []) {
    const [token = "", ...parameters] = part.split(";").map((value) => value.trim().toLowerCase());
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    weights.set(token, quality === undefined ? 1 : Number(quality.slice(2)));
  }
  const weight = (encoding: Encoding) => weights.get(encoding) ?? weights.get("*") ?? 0;
  return ENCODINGS.filter((encoding) => weight(encoding) > 0).sort(
    (left, right) => weight(right) - weight(left),
  );
};

const compressibleType = (contentType: string) => {
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    (mediaType.startsWith("text/") && mediaType !== "text/event-stream") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/javascript" ||
    mediaType === "image/svg+xml"
  );
};

const varyOnEncoding = (response: HttpServerResponse.HttpServerResponse) => {
  const vary = response.headers.vary;
  return vary !== undefined && /\baccept-encoding\b/iu.test(vary)
    ? response
    : HttpServerResponse.setHeader(
        response,
        "vary",
        vary === undefined ? "Accept-Encoding" : `${vary}, Accept-Encoding`,
      );
};

const compress = (encoding: Encoding, bytes: Uint8Array) =>
  Effect.callback<Uint8Array, CompressionError>((resume) => {
    const done = (error: Error | null, result: Uint8Array) =>
      resume(
        error === null
          ? Effect.succeed(result)
          : Effect.fail(CompressionError.make({ encoding, cause: error })),
      );
    if (encoding === "br")
      brotliCompress(
        bytes,
        {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
          },
        },
        done,
      );
    else gzip(bytes, { level: GZIP_LEVEL }, done);
  });

/**
 * Compresses `response` in the encoding that `request` prefers. Only a text body of at least
 * `MIN_BYTES` bytes, held in memory, is compressed: streamed bodies, such as event streams and
 * files, are sent as they are. A response that has a `Content-Encoding` or `Cache-Control:
 * no-store` is sent as it is. A compression failure sends the response uncompressed.
 */
const encode = Effect.fn("Compression.encode")(function* (
  request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse,
) {
  if (response.status === 304) return varyOnEncoding(response);
  const body = response.body;
  if (
    body._tag !== "Uint8Array" ||
    body.contentLength < MIN_BYTES ||
    !compressibleType(body.contentType) ||
    response.headers["content-encoding"] !== undefined ||
    /\bno-store\b/iu.test(response.headers["cache-control"] ?? "")
  )
    return response;
  const varied = varyOnEncoding(response);
  const [encoding] = acceptedEncodings(request.headers["accept-encoding"]);
  if (encoding === undefined) return varied;
  return yield* compress(encoding, body.body).pipe(
    Effect.tap((bytes) =>
      Effect.annotateCurrentSpan({
        encoding,
        bytes: body.contentLength,
        encodedBytes: bytes.length,
      }),
    ),
    Effect.map((bytes) =>
      HttpServerResponse.setBody(varied, HttpBody.uint8Array(bytes, body.contentType)).pipe(
        HttpServerResponse.setHeader("content-encoding", encoding),
      ),
    ),
    Effect.catchTag("CompressionError", (error) =>
      Effect.logWarning("Response sent uncompressed after a compression failure", {
        encoding: error.encoding,
        bytes: body.contentLength,
        cause: String(error.cause),
      }).pipe(Effect.as(varied)),
    ),
  );
});

/**
 * Compresses the response bodies that the request accepts in Brotli or gzip, after every other
 * pre-response handler, such as the validators of conditional reads, has run.
 */
export const responseCompression = HttpRouter.middleware(
  // A pre-response handler runs in the order it was added, so this one is added after the route.
  (handler) => Effect.ensuring(handler, HttpEffect.appendPreResponseHandler(encode)),
  { global: true },
);

/**
 * Serves the file at `path`, or its precompressed `.br` or `.gz` copy in the encoding that the
 * request prefers when that copy exists. Fails as `HttpServerResponse.file` does for `path`.
 */
export const encodedFile = Effect.fn("Compression.encodedFile")(function* (path: string) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const headers = { vary: "Accept-Encoding" };
  for (const encoding of acceptedEncodings(request.headers["accept-encoding"])) {
    const copy = `${path}${EXTENSIONS[encoding]}`;
    const encoded = yield* HttpServerResponse.file(copy, {
      contentType: Option.getOrElse(Mime.getType(path), () => "application/octet-stream"),
      headers: { ...headers, "content-encoding": encoding },
    }).pipe(
      Effect.asSome,
      Effect.catchTag("PlatformError", (error) =>
        Effect.logDebug("Precompressed file unavailable", {
          file: copy,
          reason: error.reason._tag,
        }).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isSome(encoded)) return encoded.value;
  }
  return yield* HttpServerResponse.file(path, { headers });
});

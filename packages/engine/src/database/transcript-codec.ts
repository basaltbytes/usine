import { brotliCompress, brotliDecompress, constants } from "node:zlib";
import { Effect, Layer } from "effect";
import { EnginePersistenceError } from "../engine/error.ts";
import { TranscriptCodec } from "../store/transcript/codec.ts";

export const transcriptCodecLayer = Layer.succeed(TranscriptCodec)({
  compress: Effect.fn("TranscriptCodec.compress")((text) =>
    Effect.callback<Uint8Array, EnginePersistenceError>((resume) => {
      brotliCompress(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }, (cause, body) =>
        resume(
          cause === null
            ? Effect.succeed(body)
            : Effect.fail(
                EnginePersistenceError.make({ operation: "compress transcript segment", cause }),
              ),
        ),
      );
    }),
  ),
  decompress: Effect.fn("TranscriptCodec.decompress")((body) =>
    Effect.callback<string, EnginePersistenceError>((resume) => {
      brotliDecompress(body, (cause, raw) =>
        resume(
          cause === null
            ? Effect.succeed(raw.toString("utf8"))
            : Effect.fail(
                EnginePersistenceError.make({ operation: "decompress transcript segment", cause }),
              ),
        ),
      );
    }),
  ),
});

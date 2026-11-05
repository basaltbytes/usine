import { Context, type Effect } from "effect";
import type { EnginePersistenceError } from "../../engine/error.ts";

/** Compression supplied by the SQLite deployment; other adapters own their storage format. */
export class TranscriptCodec extends Context.Service<
  TranscriptCodec,
  {
    readonly compress: (text: string) => Effect.Effect<Uint8Array, EnginePersistenceError>;
    readonly decompress: (body: Uint8Array) => Effect.Effect<string, EnginePersistenceError>;
  }
>()("@usine/engine/store/transcript/codec/TranscriptCodec") {}

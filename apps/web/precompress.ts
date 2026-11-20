import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path } from "effect";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

const TEXT_FILE = /\.(?:css|html|js|json|svg|txt)$/u;

const compressed = (encode: (done: (error: Error | null, bytes: Uint8Array) => void) => void) =>
  Effect.callback<Uint8Array, Error>((resume) =>
    encode((error, bytes) => resume(error === null ? Effect.succeed(bytes) : Effect.fail(error))),
  );

const precompressFile = Effect.fn("precompressFile")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* fileSystem.readFile(file);
  const variants = yield* Effect.all(
    {
      ".br": compressed((done) =>
        brotliCompress(
          source,
          {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
            },
          },
          done,
        ),
      ),
      ".gz": compressed((done) => gzip(source, { level: constants.Z_BEST_COMPRESSION }, done)),
    },
    { concurrency: "unbounded" },
  );
  yield* Effect.forEach(
    Object.entries(variants).filter(([, bytes]) => bytes.length < source.length),
    ([extension, bytes]) => fileSystem.writeFile(`${file}${extension}`, bytes),
    { discard: true },
  );
});

/**
 * Writes a Brotli `.br` file and a gzip `.gz` file next to each text file of the build. The server
 * sends one of them to a client that accepts its encoding. A copy that isn't smaller than its file
 * is not written.
 */
export const precompress = (): Plugin => ({
  name: "usine:precompress",
  apply: "build",
  writeBundle: (options, bundle) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = options.dir ?? "dist";
      yield* Effect.forEach(
        Object.keys(bundle).filter((name) => TEXT_FILE.test(name)),
        (name) => precompressFile(path.join(directory, name)),
        { concurrency: 8, discard: true },
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise),
});

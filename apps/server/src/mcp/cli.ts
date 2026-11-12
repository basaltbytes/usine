import { NodeStdio } from "@effect/platform-node";
import type { InstanceDirectory } from "@usine/core/instance";
import { Config, Effect, Layer, Option } from "effect";
import { readAdminToken } from "../auth/local.ts";
import type { McpCommand } from "../cli.ts";
import { instanceFiles, readRecord } from "../instance/record.ts";
import { McpStartError, stdioServer } from "./stdio.ts";

/**
 * Runs `usine mcp`. With `--origin`, it serves the tools of that instance with `USINE_TOKEN`;
 * otherwise it serves the running instance of `directory` with the local admin token.
 */
export const mcpCommand = Effect.fn("Cli.mcp")(function* (
  directory: InstanceDirectory,
  command: McpCommand,
) {
  const target = yield* Option.match(command.origin, {
    onSome: (origin) =>
      Config.Redacted("USINE_TOKEN").pipe(
        Effect.mapBoth({
          onSuccess: (token) => ({ origin: String(origin), token }),
          onFailure: () =>
            McpStartError.make({
              message: `Set USINE_TOKEN to an instance token for ${origin}. Run usine sign-in ${origin} to create one.`,
            }),
        }),
      ),
    onNone: () =>
      Effect.gen(function* () {
        const record = yield* readRecord(instanceFiles(directory)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.mapError(() =>
            McpStartError.make({
              message:
                "No usine up runs in this folder. Start it, run usine mcp from the instance folder, or pass --origin <url>.",
            }),
          ),
        );
        const token = yield* readAdminToken(directory);
        return { origin: `http://127.0.0.1:${record.launch.port}`, token };
      }),
  });
  yield* Effect.annotateCurrentSpan({ origin: target.origin });
  return yield* Layer.launch(
    stdioServer(target.origin, target.token).pipe(Layer.provide(NodeStdio.layer)),
  );
});

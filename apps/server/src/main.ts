#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Match, Option } from "effect";
import { CLI_USAGE, packageVersion, parseCli } from "./cli.ts";

const main = Effect.gen(function* () {
  const command = yield* parseCli(process.argv.slice(2), {
    port: Option.fromNullishOr(process.env.USINE_PORT),
    allowVolatileInstance: Option.fromNullishOr(process.env.USINE_ALLOW_VOLATILE_INSTANCE),
  });
  return yield* Match.valueTags(command, {
    HelpCommand: () => Console.log(CLI_USAGE),
    VersionCommand: () => Effect.flatMap(packageVersion(), Console.log),
    UpCommand: ({ port, allowVolatileInstance }) =>
      Effect.flatMap(
        Effect.promise(() => import("./up.ts")),
        ({ up }) => up(port, allowVolatileInstance),
      ),
  });
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.catchTags({
    CliUsageError: ({ message }) =>
      Console.error(message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    VolatileInstanceDirectoryError: ({ directory, root }) =>
      Console.error(
        `Refusing to start: ${directory} sits under ${root}, which the OS clears. The runtime store there is the only copy of every Run and transcript. Move the instance folder, or pass --allow-volatile-instance (or USINE_ALLOW_VOLATILE_INSTANCE=1) to proceed anyway.`,
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    PortInUseError: ({ port }) =>
      Console.error(
        `Port ${port} is already in use. Stop the process using it or run usine up --port <port>.`,
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
  }),
);

NodeRuntime.runMain(main);

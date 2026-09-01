#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Match, Option } from "effect";
import { CLI_USAGE, packageVersion, parseCli } from "./cli.ts";

const main = Effect.gen(function* () {
  const command = yield* parseCli(
    process.argv.slice(2),
    Option.fromNullishOr(process.env.USINE_PORT),
  );
  return yield* Match.valueTags(command, {
    HelpCommand: () => Console.log(CLI_USAGE),
    VersionCommand: () => Effect.flatMap(packageVersion(), Console.log),
    UpCommand: ({ port }) =>
      Effect.flatMap(
        Effect.promise(() => import("./up.ts")),
        ({ up }) => up(port),
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

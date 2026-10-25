// A stand-in for `usine up` that holds the instance like the real one: it parses its arguments as
// `usine up` does, writes the instance record, drains on the first SIGTERM, and answers
// GET /api/overview and /api/configuration. It reads the runs to list from `fixture-runs.json` in
// its working directory, and a gateway admin token variable from `fixture-gateway-env`. If
// `fixture-drain` contains `never`, only a second signal ends its drain.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, DateTime, Deferred, Duration, Effect, Option } from "effect";
import { parseCli } from "../../src/cli.ts";
import { holdInstance } from "../../src/instance/lock.ts";
import { InstanceRecord, ProcessId, currentLaunch } from "../../src/instance/record.ts";
import { withGracefulShutdown } from "../../src/shutdown.ts";

const directory = process.cwd();
const fixtureFile = (name) => join(directory, name);
const runs = () =>
  existsSync(fixtureFile("fixture-runs.json"))
    ? JSON.parse(readFileSync(fixtureFile("fixture-runs.json"), "utf8"))
    : [];
const drainsForever = () =>
  existsSync(fixtureFile("fixture-drain")) &&
  readFileSync(fixtureFile("fixture-drain"), "utf8").trim() === "never";
const workers = () =>
  existsSync(fixtureFile("fixture-gateway-env"))
    ? [
        {
          gateway: {
            adminTokenEnv: readFileSync(fixtureFile("fixture-gateway-env"), "utf8").trim(),
          },
        },
      ]
    : [{ gateway: null }];

const responses = {
  "/api/overview": () => ({ _tag: "Ready", projects: [{ runs: runs() }], loops: [], needsYou: [] }),
  "/api/configuration": () => ({ workers: workers() }),
};

const listen = (port) =>
  Effect.acquireRelease(
    Effect.callback((resume) => {
      const server = createServer((request, response) => {
        const body = responses[request.url];
        if (body === undefined) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body()));
      });
      server.listen({ host: "127.0.0.1", port }, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback((resume) => server.close(() => resume(Effect.void))),
  );

const noEnvironment = {
  port: Option.none(),
  logLevel: Option.none(),
  allowVolatileInstance: Option.none(),
};

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const command = yield* parseCli(process.argv.slice(2), noEnvironment);
      if (command._tag !== "UpCommand") {
        return yield* Effect.die(new Error(`Unexpected arguments: ${process.argv}`));
      }
      const { port, logLevel, allowVolatileInstance } = command;
      const record = new InstanceRecord({
        pid: ProcessId.make(process.pid),
        version: "0.0.0-fixture",
        startedAt: yield* DateTime.now,
        launch: yield* currentLaunch(port, logLevel, allowVolatileInstance),
      });
      yield* holdInstance(directory, record);
      const requested = yield* Deferred.make();
      yield* withGracefulShutdown(
        Effect.gen(function* () {
          yield* listen(port);
          yield* Console.log(`fixture listening on ${port}`);
          return {
            running: Effect.never,
            drain: Effect.suspend(() => (drainsForever() ? Effect.never : Effect.void)),
          };
        }),
        requested,
        Effect.succeed(Duration.infinity),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

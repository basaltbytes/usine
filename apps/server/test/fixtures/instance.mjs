// A stand-in for `usine up` that holds the instance like the real one: it parses its arguments as
// `usine up` does, writes the instance record, drains on the first SIGTERM, and answers
// GET /api/overview and /api/configuration. It reads the runs to list from `fixture-runs.json` in
// its working directory, and a gateway admin token variable from `fixture-gateway-env`. If
// `fixture-drain` contains `never`, only a second signal ends its drain. If `fixture-close`
// contains `never`, its runtime scope never closes, so only SIGKILL stops it. If `fixture-startup`
// contains `<lines> <milliseconds>`, it logs that many lines at that interval before it listens, as
// startup recovery does; if it contains `never`, it never listens. If `fixture-unit` contains a
// systemd service name, it records that a service by that name runs it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, DateTime, Deferred, Duration, Effect, Option } from "effect";
import { parseCli } from "../../src/cli.ts";
import { holdInstance } from "../../src/instance/lock.ts";
import { InstanceRecord, ProcessId, currentLaunch } from "../../src/instance/record.ts";
import { SystemdUnit } from "../../src/instance/systemd.ts";
import { withGracefulShutdown } from "../../src/shutdown.ts";

const directory = process.cwd();
const fixtureFile = (name) => join(directory, name);
const runs = () =>
  existsSync(fixtureFile("fixture-runs.json"))
    ? JSON.parse(readFileSync(fixtureFile("fixture-runs.json"), "utf8"))
    : [];
const never = (name) =>
  existsSync(fixtureFile(name)) && readFileSync(fixtureFile(name), "utf8").trim() === "never";
const startup = () => {
  const plan = existsSync(fixtureFile("fixture-startup"))
    ? readFileSync(fixtureFile("fixture-startup"), "utf8").trim()
    : "";
  if (plan === "never") return Effect.never;
  const [lines, milliseconds] = plan === "" ? [0, 0] : plan.split(" ").map(Number);
  return Effect.forEach(
    Array.from({ length: lines }, (_, line) => line + 1),
    (line) =>
      Effect.sleep(milliseconds).pipe(
        Effect.andThen(Console.log(`fixture reconciled checkout ${line}`)),
      ),
    { discard: true },
  );
};
const systemdUnit = () =>
  existsSync(fixtureFile("fixture-unit"))
    ? Option.some(SystemdUnit.make(readFileSync(fixtureFile("fixture-unit"), "utf8").trim()))
    : Option.none();
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
        if (request.headers.authorization !== `Bearer ${"l".repeat(43)}`) {
          response.writeHead(401).end();
          return;
        }
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
  origin: Option.none(),
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
      const { port } = command;
      const record = new InstanceRecord({
        pid: ProcessId.make(process.pid),
        version: "0.0.0-fixture",
        startedAt: yield* DateTime.now,
        launch: yield* currentLaunch(command),
        systemdUnit: systemdUnit(),
      });
      yield* holdInstance(directory, record);
      writeFileSync(join(directory, ".usine/admin-token"), "l".repeat(43), { mode: 0o600 });
      const requested = yield* Deferred.make();
      yield* withGracefulShutdown(
        Effect.gen(function* () {
          yield* startup();
          yield* listen(port);
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => (never("fixture-close") ? Effect.never : Effect.void)),
          );
          yield* Console.log(`fixture listening on ${port}`);
          return {
            running: Effect.never,
            drain: Effect.suspend(() => (never("fixture-drain") ? Effect.never : Effect.void)),
          };
        }),
        requested,
        Effect.succeed(Duration.infinity),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

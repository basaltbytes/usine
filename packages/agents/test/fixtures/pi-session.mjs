import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import {
  AgentSessionId,
  ChildSession,
  HarnessSession,
  HarnessSessionId,
} from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Effect, Fiber, Logger, Option, Schema, Stream } from "effect";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { piRuntime, piSdkLive } from "../../src/harness/pi/pi.ts";
import { ChildRequest, WorkingDirectory, SessionOperationError } from "../../src/runtime.ts";

const [cwd, id, mode] = process.argv.slice(2);
const request = ChildRequest.make({
  cwd: WorkingDirectory.make(cwd),
  prompt:
    id === undefined ? "Remember the code word: cobalt-otter." : "What code word did I give you?",
  session: ChildSession.make({
    id: AgentSessionId.make("pi-child-1"),
    parentId: AgentSessionId.make("parent-1"),
    agent: AgentName.make("developer"),
    brain: BrainSpec.make({
      harness: Harness.make("pi"),
      model: ModelId.make("local/session-test"),
      effort: "off",
    }),
  }),
  environment: {},
  host: LocalProcess.make(),
  worker: WorkerName.make("local"),
  machine: Option.none(),
});

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* piRuntime;
      const running = yield* id === undefined
        ? runtime.launch(request)
        : mode === "request"
          ? runtime.launch(
              ChildRequest.make({
                ...request,
                resume: Option.some(HarnessSession.make({ id: HarnessSessionId.make(id), cwd })),
              }),
            )
          : Effect.gen(function* () {
              const reopened = yield* runtime.resume(
                request,
                HarnessSession.make({ id: HarnessSessionId.make(id), cwd }),
              );
              if (Option.isNone(reopened))
                return yield* SessionOperationError.make({
                  operation: "launch",
                  sessionId: Option.some(request.session.id),
                  message: "Pi session was not found",
                  cause: "missing",
                });
              yield* reopened.value.running.steer(request.prompt);
              return reopened.value.running;
            });
      const events = yield* Effect.forkChild(Stream.runCollect(running.events));
      const result = yield* running.result;
      const transcript = yield* Fiber.join(events);
      const started = transcript.find((event) => event._tag === "SessionStarted");
      if (started === undefined || Option.isNone(started.harnessSession)) {
        throw new Error("Pi child did not record its saved session");
      }
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ saved: HarnessSession, result: Schema.String })),
      )({ saved: started.harnessSession.value, result: result.message });
      process.stdout.write(encoded);
    }),
  ).pipe(Effect.provide(piSdkLive), Effect.provide(Logger.layer([Logger.make(() => {})]))),
);

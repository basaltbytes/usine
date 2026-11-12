// The Pi SDK starts sessions with native Promises.
// @effect-diagnostics newPromise:off
import { assert } from "@effect/vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { piChildLayer } from "../../src/harness/pi/pi.ts";
import { PiSdk } from "../../src/harness/pi/sdk.ts";
import { ChildRequest, WorkingDirectory } from "../../src/runtime.ts";
import type { FixtureOptions } from "./fixture.ts";
import { type Scenario, Transcript } from "./transcript.ts";

/** The port whose inbound entries are the provider's assistant messages, in order. */
const PROVIDER_PORT = "pi:1/provider";

/** An assistant message that a Pi provider returned for a failed request. */
const ProviderError = Schema.Struct({
  role: Schema.Literal("assistant"),
  stopReason: Schema.Literal("error"),
  errorMessage: Schema.String,
  timestamp: Schema.Int,
});

/**
 * Opens a recorded Pi session. A faux provider returns the recorded provider messages to a real Pi
 * SDK session, which the Pi harness runs; `save` checks that Pi requested each one.
 */
export const openPiFixture = (scenario: Scenario, options: FixtureOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = fileURLToPath(new URL(`../fixtures/replay/${scenario}/pi.json`, import.meta.url));
    const source = yield* fs.readFileString(file).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript), {
          onExcessProperty: "error",
        }),
      ),
    );
    const transcript = options.transform?.(source) ?? source;
    assert.strictEqual(transcript.protocol, "pi-sdk");
    assert.strictEqual(transcript.scenario, scenario);
    assert.strictEqual(transcript.harnessVersion, VERSION);
    const responses = yield* Effect.forEach(
      transcript.entries.flatMap((entry) =>
        entry.type === "emit_inbound" && entry.port === PROVIDER_PORT ? [entry.payload] : [],
      ),
      (payload) => Schema.decodeUnknownEffect(ProviderError)(payload),
    );
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "usine-replay-pi-" });
    const faux = fauxProvider();
    faux.setResponses(
      responses.map(({ errorMessage, timestamp }) =>
        fauxAssistantMessage([], { stopReason: "error", errorMessage, timestamp }),
      ),
    );
    const modelRuntime = yield* Effect.promise(() =>
      ModelRuntime.create({
        authPath: path.join(directory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    modelRuntime.registerNativeProvider(faux.provider);
    const { session } = yield* Effect.acquireRelease(
      Effect.promise(() =>
        createAgentSession({
          agentDir: directory,
          cwd: directory,
          model: faux.getModel(),
          modelRuntime,
          tools: [],
          sessionManager: SessionManager.inMemory(directory),
          settingsManager: SettingsManager.inMemory(),
        }),
      ),
      ({ session }) => Effect.sync(() => session.dispose()),
    );
    const model = ModelId.make(`${faux.provider.id}/${faux.getModel().id}`);
    const sdk = Layer.succeed(PiSdk)({
      start: () =>
        Promise.resolve({
          _tag: "Started",
          harnessSession: Option.none(),
          model,
          pool: "chatgptPlan",
          session,
          tools: [],
        }),
    });
    return {
      backend: piChildLayer.pipe(Layer.provideMerge(sdk)),
      request: ChildRequest.make({
        worker: WorkerName.make("replay-worker"),
        machine: Option.none(),
        host: LocalProcess.make(),
        environment: transcript.environment,
        cwd: WorkingDirectory.make(directory),
        session: ChildSession.make({
          id: AgentSessionId.make("replay-parent:child:1"),
          parentId: AgentSessionId.make("replay-parent"),
          agent: AgentName.make("replay"),
          brain: BrainSpec.make({ harness: Harness.make("pi"), model, effort: "low" }),
        }),
        prompt: "Reply with exactly REPLAY_DONE. Do not use tools.",
      }),
      save: Effect.sync(() =>
        assert.strictEqual(faux.state.callCount, responses.length, "Pi requests each response"),
      ),
    };
  });

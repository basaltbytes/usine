import { assert } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { AgentName } from "@usine/core/agent";
import { BrainSpec, Harness, ModelId } from "@usine/core/agent/brain";
import { AgentSessionId, ChildSession } from "@usine/core/agent/session";
import { WorkerName } from "@usine/core/worker";
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { LocalProcess } from "../../src/child-host/child-host.ts";
import { OPENCODE_BRIDGE } from "../../src/harness/opencode/bridge/bundle.js";
import {
  OPENCODE_BASE_URL,
  OPENCODE_HOME,
  opencode,
} from "../../src/harness/opencode/descriptor.ts";
import { openCodeChildLayer, openCodeServerLive } from "../../src/harness/opencode/opencode.ts";
import { ChildRequest, ChildSessionJournal, WorkingDirectory } from "../../src/runtime.ts";
import { type FixtureOptions, fixtureFile, recordingModel } from "./fixture.ts";
import { processTransport } from "./process.ts";
import { isJsonObject, type SessionScenario, Tape, Transcript } from "./transcript.ts";

/**
 * The scenarios that OpenCode replays at the `ChildHost` boundary: the ones that its capability
 * profile declares, and the operator messages of the coding agent.
 */
export const openCodeScenarios: ReadonlyArray<SessionScenario> = [
  "simple",
  "steer",
  "queued-message",
  "interrupt-guidance",
  "hold-release",
  "restart",
];

const encoder = new TextEncoder();
/** The OpenCode message IDs that the runtime derives from operator message IDs, which are random. */
const LIVE_ID = /msg_usine_[A-Za-z0-9]+_[0-9a-f]{32}/gu;
/** The IDs that a transcript records in their place, numbered in order of first use. */
const RECORDED_ID = /msg_usine_replay_\d+/gu;

const ModelList = Schema.Struct({
  id: Schema.Union([Schema.Int, Schema.String]),
  status: Schema.Int,
  body: Schema.Struct({
    location: Schema.Json,
    data: Schema.Array(Schema.Struct({ providerID: Schema.String, id: Schema.String })),
  }),
});
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const decodeModelList = Schema.decodeUnknownOption(ModelList);
// The transport maps each line synchronously, and a decoded JSON value always encodes.
// @effect-diagnostics-next-line schemaSync:off
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/**
 * Returns `line` with the model list that OpenCode answers cut to `model`, the only one that the
 * session reads, so that a transcript doesn't hold OpenCode's whole catalog.
 */
const trimModelList = (line: string, model: string): string => {
  const json = decodeJson(line);
  if (Option.isNone(json) || Option.isNone(decodeModelList(json.value))) return line;
  const answer = json.value;
  if (!isJsonObject(answer)) return line;
  const body = answer.body;
  if (body === undefined || !isJsonObject(body)) return line;
  const data = body.data;
  if (data === undefined || !Array.isArray(data)) return line;
  return encodeJson({
    ...answer,
    body: {
      ...body,
      data: data.filter(
        (entry: Schema.Json) =>
          isJsonObject(entry) && entry.providerID === "openai" && entry.id === model,
      ),
    },
  });
};

/** Wraps `inner` so that a process's model list is cut to `model` before a recording sees it. */
const trimmedModelLists = (
  inner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  model: string,
) =>
  ChildProcessSpawner.make((command) =>
    Effect.map(inner.spawn(command), (handle) =>
      ChildProcessSpawner.makeHandle({
        ...handle,
        stdout: handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.map((line) => encoder.encode(`${trimModelList(line, model)}\n`)),
        ),
      }),
    ),
  );

/**
 * Wraps `inner` so that a process's input carries recorded message IDs in place of the live ones,
 * and its output the live ones again. OpenCode accepts the recorded IDs, so a recording sends them
 * to the real process too.
 */
const recordedMessageIds = (inner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => {
  const recorded = new Map<string, string>();
  const live = new Map<string, string>();
  const outbound = (line: string) =>
    line.replaceAll(LIVE_ID, (id) => {
      const known = recorded.get(id);
      if (known !== undefined) return known;
      const assigned = `msg_usine_replay_${recorded.size + 1}`;
      recorded.set(id, assigned);
      live.set(assigned, id);
      return assigned;
    });
  const inbound = (line: string) => line.replaceAll(RECORDED_ID, (id) => live.get(id) ?? id);
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert(command._tag === "StandardCommand");
      const stdin = command.options.stdin;
      const mapped =
        Predicate.hasProperty(stdin, "stream") && Stream.isStream(stdin.stream)
          ? ChildProcess.make(command.command, command.args, {
              ...command.options,
              stdin: {
                stream: stdin.stream.pipe(
                  Stream.decodeText(),
                  Stream.splitLines,
                  Stream.map((line) => encoder.encode(`${outbound(line)}\n`)),
                ),
                endOnDone: stdin.endOnDone,
              },
            })
          : command;
      const handle = yield* inner.spawn(mapped);
      return ChildProcessSpawner.makeHandle({
        ...handle,
        stdout: handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.map((line) => encoder.encode(`${inbound(line)}\n`)),
        ),
      });
    }),
  );
};

const ModelServer = Schema.fromJsonString(Schema.Struct({ url: Schema.String }));
/** The names of the tools of one model request, which the scripted model server prints. */
const ModelRequest = Schema.Struct({ tools: Schema.Array(Schema.String) });
const decodeModelRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelRequest));

/**
 * The port whose entries hold the tool names of each model request, which a transcript records
 * beside the bridge's traffic, because OpenCode calls the model server outside the bridge.
 */
export const MODEL_REQUESTS = "model:1/requests";

/**
 * Starts the scripted model server that a recording's OpenCode calls, records the tool names of
 * each of its requests on `MODEL_REQUESTS`, and returns its base URL. It stops with the scope.
 */
const modelServer = (tape: Tape) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const program = fileURLToPath(new URL("../fixtures/opencode-model.mjs", import.meta.url));
    const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [program]));
    const address = yield* Deferred.make<string>();
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          if (!(yield* Deferred.isDone(address))) {
            const { url } = yield* Schema.decodeEffect(ModelServer)(line);
            return yield* Deferred.succeed(address, url);
          }
          const request = yield* decodeModelRequest(line);
          tape.inbound(MODEL_REQUESTS, { tools: [...request.tools] });
        }),
      ),
      Effect.orDie,
      Effect.forkScoped,
    );
    return yield* Deferred.await(address);
  });

/** Reads the model requests of a replayed transcript, which no process asks for, until the scope closes. */
const drainModelRequests = (tape: Tape) =>
  Effect.promise(() => tape.read(MODEL_REQUESTS)).pipe(Effect.forever, Effect.forkScoped);

/**
 * Returns a recording's environment: its own HOME and OpenCode home, the scripted model server's
 * base URL, a placeholder key, and this process's PATH, each bound to its placeholder.
 */
const recordingEnvironment = Effect.fn("OpenCodeFixture.recordingEnvironment")(function* (
  tape: Tape,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // OpenCode writes its logs and caches under HOME, which a recording keeps to itself.
  const userHome = yield* fs.makeTempDirectoryScoped({ prefix: "usine-replay-home-" });
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "usine-replay-opencode-" });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installed = yield* spawner.string(
    ChildProcess.make("opencode", ["--version"], { env: { HOME: userHome }, extendEnv: true }),
  );
  assert.include(installed, version, "record fixtures with the pinned OpenCode version");
  const url = yield* modelServer(tape);
  tape.bind(userHome, "$HOME");
  tape.bind(home, "$OPENCODE_HOME");
  tape.bind(url, "$MODEL_URL");
  const recorded = {
    HOME: userHome,
    [OPENCODE_HOME]: home,
    [OPENCODE_BASE_URL]: url,
    // The scripted model server takes any key.
    OPENAI_API_KEY: "sk-replay",
  };
  if (env.PATH === undefined) return recorded;
  tape.bind(env.PATH, "$PATH");
  return { ...recorded, PATH: env.PATH };
});

/** Returns a replay's environment: the transcript's, with this process's PATH. */
const replayedEnvironment = (
  tape: Tape,
  source: Transcript,
  scenario: SessionScenario,
  version: string,
) => {
  assert.strictEqual(source.scenario, scenario);
  assert.strictEqual(source.protocol, "opencode-bridge");
  assert.strictEqual(source.harnessVersion, version);
  if (env.PATH === undefined || source.environment.PATH === undefined) return source.environment;
  tape.bind(env.PATH, "$PATH");
  return { ...source.environment, PATH: env.PATH };
};

/**
 * Opens an OpenCode fixture: a child on the bridge whose process traffic is recorded against the
 * pinned binary, with the scripted model server, or replayed.
 */
export const openOpenCodeFixture = (
  scenario: SessionScenario,
  mode: "record" | "replay",
  options: FixtureOptions = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "usine-replay-" });
    const file = fixtureFile("opencode", scenario);
    const source =
      mode === "record"
        ? ("record" as const)
        : yield* fs.readFileString(file).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript), {
                onExcessProperty: "error",
              }),
            ),
            Effect.map((transcript) => options.transform?.(transcript) ?? transcript),
          );
    const tape = new Tape(source);
    tape.bind(cwd, "$WORKTREE");
    // The model check names the checkout in its query.
    tape.bind(encodeURIComponent(cwd), "$ENCODED_WORKTREE");
    tape.bind(OPENCODE_BRIDGE, "$OPENCODE_BRIDGE");
    const version = opencode.worker.install[0]?.version;
    assert(version !== undefined);
    const environment =
      source === "record"
        ? yield* recordingEnvironment(tape, version)
        : replayedEnvironment(tape, source, scenario, version);
    const model = source === "record" ? recordingModel("opencode") : source.model;
    assert(model !== undefined, "set the integration model to record traffic");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const live = mode === "record" ? trimmedModelLists(spawner, model) : undefined;
    if (source !== "record") yield* drainModelRequests(tape);
    const transport = Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.map(ChildProcessSpawner.ChildProcessSpawner, recordedMessageIds),
    ).pipe(Layer.provide(processTransport(tape, live)));
    /** The OpenCode server on the recorded transport, which a harness runtime needs. */
    const harness = openCodeServerLive.pipe(
      Layer.provideMerge(transport),
      Layer.provideMerge(NodeServices.layer),
    );
    const backend = openCodeChildLayer.pipe(
      Layer.provideMerge(ChildSessionJournal.layerNoop),
      Layer.provide(harness),
      Layer.provideMerge(NodeServices.layer),
    );
    const request = ChildRequest.make({
      worker: WorkerName.make("replay-worker"),
      machine: Option.none(),
      host: LocalProcess.make(),
      environment,
      cwd: WorkingDirectory.make(cwd),
      session: ChildSession.make({
        id: AgentSessionId.make("replay-parent:child:1"),
        parentId: AgentSessionId.make("replay-parent"),
        agent: AgentName.make("replay"),
        brain: BrainSpec.make({
          harness: Harness.make("opencode"),
          model: ModelId.make(model),
          effort: "low",
        }),
      }),
      prompt: "Reply with exactly REPLAY_DONE. Do not use tools.",
    });
    const save = Effect.gen(function* () {
      yield* tape.settled;
      tape.assertComplete();
      if (mode !== "record") return;
      const transcript = {
        protocol: "opencode-bridge",
        harnessVersion: version,
        model,
        scenario,
        environment: tape.normalize(environment),
        entries: tape.entries,
      };
      const decoded = yield* Schema.decodeUnknownEffect(Transcript)(transcript);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Transcript))(decoded);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, encoded + "\n");
    });
    return {
      tape,
      cwd,
      request,
      backend,
      harness,
      controls: {
        nativeReceipts: true,
        drop: Effect.void,
        boundary: Effect.void,
        sessionReleased: Effect.void,
        releaseCommand: fs.writeFileString(`${cwd}/release`, "ready").pipe(Effect.orDie),
        // A recording waits until the command runs, so the interrupt stops it.
        toolReady:
          mode === "record"
            ? Effect.gen(function* () {
                while (!(yield* fs.exists(`${cwd}/started`))) yield* Effect.sleep("10 millis");
              }).pipe(Effect.timeout("30 seconds"), Effect.orDie)
            : Effect.void,
      },
      save,
    };
  });

// Pi's model runtime streams through native Promise callbacks and async iterators.
// @effect-diagnostics asyncFunction:off
// Recorded provider events are decoded synchronously at the stream boundary.
// @effect-diagnostics schemaSync:off
import {
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Predicate, Schema } from "effect";
import { piSdkLayer } from "../../src/harness/pi/sdk.ts";
import { isJsonObject, Tape } from "./transcript.ts";

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const timings = new Set(["timestamp", "durationMs"]);

/** Drops the wall-clock times and durations of every message, which differ between runs. */
const withoutTimings = (value: Schema.Json): Schema.Json =>
  Array.isArray(value)
    ? value.map(withoutTimings)
    : isJsonObject(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !timings.has(key))
            .map(([key, item]) => [key, withoutTimings(item)]),
        )
      : value;

/** An event that the provider stream emitted when the transcript was recorded. */
const RecordedEvent = Schema.declare(
  (value): value is AssistantMessageEvent =>
    Predicate.hasProperty(value, "type") && Predicate.isString(value.type),
  { expected: "a recorded provider stream event" },
);

/**
 * Pi sessions whose model requests go through `tape`, the Pi transport's provider stream. A
 * recording sends each request to the provider with the worker user's Pi credentials and saves its
 * stream; a replay checks each request against the transcript and answers with the saved stream.
 * Pi's tools run for real in both modes, and `agentDir` keeps the user's Pi settings out of both.
 */
export const piTransport = (tape: Tape, agentDir: string) =>
  piSdkLayer({
    agentDir: () => agentDir,
    modelRuntime: async (signal) => {
      const runtime =
        tape.source === "record"
          ? await ModelRuntime.create({ signal })
          : await ModelRuntime.create({
              signal,
              authPath: `${agentDir}/auth.json`,
              modelsPath: null,
              refreshOnCreate: false,
            });
      const live = runtime.streamSimple.bind(runtime);
      if (tape.source !== "record")
        runtime.checkAuth = () => Promise.resolve({ type: "api_key", source: "replay" });
      runtime.streamSimple = (model, context, options) => {
        const port = tape.port("pi");
        tape.outbound(port, {
          method: "stream",
          model: `${model.provider}/${model.id}`,
          reasoning: options?.reasoning ?? null,
          systemPrompt: context.systemPrompt ?? null,
          tools: (context.tools ?? []).map(({ name }) => name),
          messages: withoutTimings(json(encode(context.messages))),
        });
        const output = createAssistantMessageEventStream();
        if (tape.source === "record") {
          void forward(live(model, context, options), output, (event) =>
            tape.inbound(`${port}/events`, json(encode(event))),
          );
        } else {
          // The provider passes its payload to Pi's request hooks, such as the pause gate,
          // before it sends the request.
          void Promise.resolve(options?.onPayload?.({}, model)).then(() =>
            replay(tape, `${port}/events`, output),
          );
        }
        return output;
      };
      return runtime;
    },
  });

const forward = async (
  upstream: AssistantMessageEventStream,
  output: AssistantMessageEventStream,
  record: (event: AssistantMessageEvent) => void,
) => {
  for await (const event of upstream) {
    record(event);
    output.push(event);
  }
  output.end();
};

const replay = async (tape: Tape, port: string, output: AssistantMessageEventStream) => {
  for (;;) {
    const entry = await tape.read(port);
    if (entry.type === "runtime_exit") break;
    const event = Schema.decodeUnknownSync(RecordedEvent)(entry.payload);
    output.push(event);
    if (event.type === "done" || event.type === "error") break;
  }
  output.end();
};

// SDK transports use native Promise callbacks and async iterators.
// @effect-diagnostics newPromise:off
// @effect-diagnostics asyncFunction:off
// Recorded SDK responses are decoded synchronously at the transport boundary.
// @effect-diagnostics schemaSync:off
import { assert } from "@effect/vitest";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { Deferred, Effect, Layer, Schema } from "effect";
import { ClaudeSdk, type ClaudeQuery } from "../../src/harness/claude/sdk.ts";
import { Tape } from "./transcript.ts";

const json = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const optionsJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const Models = Schema.Array(
  Schema.Struct({
    value: Schema.String,
    resolvedModel: Schema.optionalKey(Schema.String),
  }),
);

export const claudeTransport = (
  tape: Tape,
  live?: ClaudeSdk["Service"],
  fault: "early-exit" | "none" = "none",
  hooks?: {
    readonly boundary: Deferred.Deferred<void>;
    readonly started: Deferred.Deferred<void>;
    readonly released: Deferred.Deferred<void>;
  },
) =>
  Layer.succeed(ClaudeSdk)({
    open: (input, options) => {
      const port = tape.port("claude");
      const serializedOptions = optionsJson(encode(options));
      tape.outbound(port, {
        method: "open",
        options: {
          ...serializedOptions,
          spawnClaudeCodeProcess: options.spawnClaudeCodeProcess !== undefined,
        },
      });
      const wrappedInput = async function* () {
        for await (const message of input) {
          tape.outbound(`${port}/input`, json(encode(message)));
          yield message;
        }
      };
      const recordedOptions = options;
      const hookFields = {
        session_id: Schema.String,
        transcript_path: Schema.String,
        cwd: Schema.String,
        tool_name: Schema.String,
        tool_input: Schema.Json,
        tool_use_id: Schema.String,
      };
      const hookInput = Schema.decodeUnknownSync(
        Schema.Union([
          Schema.Struct({ ...hookFields, hook_event_name: Schema.Literal("PreToolUse") }),
          Schema.Struct({
            ...hookFields,
            hook_event_name: Schema.Literal("PostToolUse"),
            tool_response: Schema.Json,
          }),
        ]),
      );
      const invokeHook = async (input: ReturnType<typeof hookInput>, signal: AbortSignal) => {
        if (input.hook_event_name === "PostToolUse" && hooks !== undefined)
          await Effect.runPromise(Deferred.await(hooks.released));
        const callback = options.hooks?.[input.hook_event_name]?.[0]?.hooks[0];
        assert(callback !== undefined);
        let returned = false;
        const completion = callback(input, input.tool_use_id, { signal }).then((result) => {
          returned = true;
          return result;
        });
        if (input.hook_event_name === "PostToolUse") {
          // Check after Promise callbacks run: entering a hook alone does not prove it held.
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert(!returned, "PostToolUse must hold until operator guidance arrives");
          if (hooks !== undefined) Deferred.doneUnsafe(hooks.boundary, Effect.void);
        }
        const result = await completion;
        tape.outbound(`${port}/hooks`, json(encode(result)));
        if (input.hook_event_name === "PreToolUse" && hooks !== undefined)
          Deferred.doneUnsafe(hooks.started, Effect.void);
        return result;
      };
      const wrappedHook: HookCallback = async (input, _id, { signal }) => {
        try {
          tape.inbound(`${port}/hooks`, json(encode(input)));
          return await invokeHook(hookInput(input), signal);
        } catch (cause) {
          tape.fail(cause);
          throw cause;
        }
      };
      const hookedOptions =
        hooks === undefined
          ? recordedOptions
          : ({
              ...recordedOptions,
              hooks: {
                ...recordedOptions.hooks,
                PreToolUse: [{ hooks: [wrappedHook], timeout: 86_400 }],
                PostToolUse: [{ hooks: [wrappedHook], timeout: 86_400 }],
              },
            } satisfies typeof options);
      if (live === undefined && hooks !== undefined) {
        void (async () => {
          for (;;) {
            const entry = await tape.read(`${port}/hooks`);
            if (entry.type === "runtime_exit") return;
            await invokeHook(hookInput(entry.payload), new AbortController().signal);
          }
        })().catch((cause: unknown) => tape.fail(cause));
      }
      const query = live?.open(
        wrappedInput(),
        fault === "early-exit"
          ? {
              ...options,
              spawnClaudeCodeProcess: (settings) => {
                const spawnOwned = options.spawnClaudeCodeProcess;
                assert(spawnOwned !== undefined);
                const child = spawnOwned(settings);
                child.kill("SIGKILL");
                return child;
              },
            }
          : hookedOptions,
      );
      if (query === undefined) {
        void (async () => {
          for await (const _message of wrappedInput()) {
          }
        })().catch((cause: unknown) => tape.fail(cause));
      }
      const call = async <A>(
        method: string,
        invoke: (query: ClaudeQuery) => Promise<A>,
      ): Promise<Schema.Json> => {
        tape.outbound(port, { method });
        if (query !== undefined) {
          try {
            const result = json(encode(await invoke(query)));
            tape.inbound(`${port}/${method}`, result);
            return result;
          } catch (cause) {
            tape.exit(`${port}/${method}`, null, String(cause));
            throw cause;
          }
        }
        const incoming = await tape.read(`${port}/${method}`);
        if (incoming.type === "runtime_exit") throw new Error(incoming.error ?? "process exited");
        return incoming.payload;
      };
      let closed = false;
      return {
        close: () => {
          if (closed) return;
          closed = true;
          tape.outbound(port, { method: "close" });
          query?.close();
        },
        interrupt: async () => {
          await call("interrupt", async (running) => {
            await running.interrupt();
            return null;
          });
        },
        supportedModels: async () =>
          Schema.decodeUnknownSync(Models)(
            await call("supportedModels", (running) => running.supportedModels()),
          ),
        usesApiKey: async () =>
          Schema.decodeUnknownSync(Schema.Boolean)(
            await call("usesApiKey", (running) => running.usesApiKey()),
          ),
        async *[Symbol.asyncIterator]() {
          if (query !== undefined) {
            try {
              for await (const message of query) {
                tape.inbound(`${port}/output`, message);
                yield message;
              }
              if (hooks !== undefined) tape.exit(`${port}/hooks`, 0, null);
              tape.exit(`${port}/output`, 0, null);
            } catch (cause) {
              if (hooks !== undefined) tape.exit(`${port}/hooks`, null, String(cause));
              tape.exit(`${port}/output`, null, String(cause));
              throw cause;
            }
            return;
          }
          for (;;) {
            const incoming = await tape.read(`${port}/output`);
            if (incoming.type === "runtime_exit") {
              if (incoming.error !== null) throw new Error(incoming.error);
              return;
            }
            yield incoming.payload;
          }
        },
      } satisfies ClaudeQuery;
    },
  });

// SDK transports use native Promise callbacks and async iterators.
// @effect-diagnostics newPromise:off
// @effect-diagnostics asyncFunction:off
// Recorded SDK responses are decoded synchronously at the transport boundary.
// @effect-diagnostics schemaSync:off
// The recorder terminates the real binary before its first protocol message.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { Layer, Schema } from "effect";
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
      const spawnRemote = options.spawnClaudeCodeProcess;
      if (live === undefined && spawnRemote !== undefined) {
        void tape
          .read(`${port}/ssh-exit`)
          .then((entry) => {
            if (entry.type !== "runtime_exit") throw new Error("expected SSH exit");
            const settings: Parameters<typeof spawnRemote>[0] = {
              command: "/bin/sh",
              args: ["-c", `exit ${entry.code ?? 1}`],
              env: {},
              signal: new AbortController().signal,
            };
            if (options.cwd !== undefined) settings.cwd = options.cwd;
            spawnRemote(settings);
          })
          .catch((cause: unknown) => tape.fail(cause));
      }
      const recordedOptions =
        spawnRemote === undefined
          ? options
          : {
              ...options,
              spawnClaudeCodeProcess: (settings: Parameters<typeof spawnRemote>[0]) => {
                const child = spawnRemote(settings);
                child.once("exit", (code) => tape.exit(`${port}/ssh-exit`, code, null));
                return child;
              },
            };
      const query = live?.open(
        wrappedInput(),
        fault === "early-exit"
          ? {
              ...options,
              spawnClaudeCodeProcess: (settings) => {
                const child = spawn(settings.command, [...settings.args], {
                  cwd: settings.cwd,
                  env: settings.env,
                  signal: settings.signal,
                  stdio: ["pipe", "pipe", "pipe"],
                });
                child.kill("SIGKILL");
                return child;
              },
            }
          : recordedOptions,
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
              tape.exit(`${port}/output`, 0, null);
            } catch (cause) {
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

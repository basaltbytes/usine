// SDK streams and hooks require native Promises, including the test implementations.
// @effect-diagnostics newPromise:off
// SDK hooks, transactions, and async iterators require Promise callbacks.
// @effect-diagnostics asyncFunction:off
import {
  query as openClaudeQuery,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Context, Effect, Layer, Match, Option, Ref, Schema } from "effect";

// The Claude SDK iterator synchronously normalizes vendor messages, including omitted undefined fields, as JSON.
// @effect-diagnostics-next-line schemaSync:off
const serializeVendorValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A user message sent to a Claude Code child through the SDK's streaming input. */
export interface ClaudeUserMessage {
  /** Identifies an input message rather than a harness output event. */
  readonly type: "user";
  readonly uuid?: string;
  /** The user-role text to submit as a task or operator guidance. */
  readonly message: {
    /** The conversation role required by the SDK for input. */
    readonly role: "user";
    /** The task or guidance text, passed unchanged to Claude Code. */
    readonly content: string;
  };
  /** Always `null`: this input is not a response to a tool call. */
  readonly parent_tool_use_id: null;
}

/** The Claude SDK launch options used by the child backend, including worker credentials, settings sources, flag settings, permissions, and process spawning. */
export type ClaudeQueryOptions = Pick<
  Options,
  | "allowDangerouslySkipPermissions"
  | "cwd"
  | "effort"
  | "env"
  | "model"
  | "pathToClaudeCodeExecutable"
  | "permissionMode"
  | "persistSession"
  | "resume"
  | "sessionId"
  | "settingSources"
  | "settings"
  | "spawnClaudeCodeProcess"
  | "thinking"
  | "hooks"
>;

/** A model name advertised by Claude Code, with its resolved ID when the SDK provides one. */
export interface ClaudeModelInfo {
  /** The name accepted by the SDK's model option, which may be an alias. */
  readonly value: string;
  /** The concrete model ID behind an alias, when Claude Code reports it. */
  readonly resolvedModel?: string;
}

/** A running Claude Code session: its message stream, model list, and stop controls. */
export interface ClaudeQuery extends AsyncIterable<Schema.Json> {
  /** Ends the query and releases the SDK's process resources. */
  readonly close: () => void;
  /** Requests that Claude stop the current turn while keeping the query available for more input. */
  readonly interrupt: () => Promise<void>;
  /** Lists the models available to this query for validating the requested brain spec. */
  readonly supportedModels: () => Promise<ReadonlyArray<ClaudeModelInfo>>;
  /** Reports whether this query uses an API key instead of a subscription token. */
  readonly usesApiKey: () => Promise<boolean>;
}

/** The service that opens Claude Code sessions. */
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    /**
     * Opens a query that consumes task and guidance messages from `input`, using `options` for
     * the model, environment, settings, and process host. The caller must close the query.
     */
    readonly open: (
      input: AsyncIterable<ClaudeUserMessage>,
      options: ClaudeQueryOptions,
    ) => ClaudeQuery;
  }
>()("@usine/agents/harness/claude/sdk/ClaudeSdk") {}

// The SDK async iterator converts each message before yielding it.
// @effect-diagnostics-next-line schemaSync:off
const decodeVendorMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const vendorMessageJson = (message: SDKMessage): Schema.Json =>
  decodeVendorMessage(serializeVendorValue(message));

/** Provides `ClaudeSdk` through the installed Agent SDK, exposing output messages as JSON for decoding by the child backend. */
export const claudeSdkLive = Layer.succeed(ClaudeSdk)({
  open: (input, options) => {
    // SAFETY: ClaudeUserMessage is the streaming-input subset of SDKUserMessage.
    const query = openClaudeQuery({ prompt: input as AsyncIterable<SDKUserMessage>, options });
    return {
      close: () => query.close(),
      interrupt: async () => {
        await query.interrupt();
      },
      supportedModels: () => query.supportedModels(),
      usesApiKey: async () => {
        const account = await query.accountInfo();
        return (
          account.apiKeySource !== undefined &&
          account.apiKeySource !== "none" &&
          account.apiKeySource !== "oauth"
        );
      },
      async *[Symbol.asyncIterator]() {
        for await (const message of query) yield vendorMessageJson(message);
      },
    };
  },
});

export class AsyncInput implements AsyncIterable<ClaudeUserMessage> {
  readonly #buffer: Array<ClaudeUserMessage> = [];
  readonly #waiters: Array<(value: IteratorResult<ClaudeUserMessage>) => void> = [];
  #ended = false;

  offer(message: ClaudeUserMessage): void {
    if (this.#ended) throw new Error("Claude input is closed");
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#buffer.push(message);
    else waiter({ done: false, value: message });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeUserMessage> {
    return {
      next: () => {
        const value = this.#buffer.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export const userMessage = (content: string, uuid?: string): ClaudeUserMessage => {
  const input: ClaudeUserMessage = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
  return uuid === undefined ? input : { ...input, uuid };
};

const ClaudeResult = Schema.Struct({ type: Schema.Literal("result") });
const ControlRequest = Schema.Struct({
  type: Schema.Literal("control_request"),
  request_id: Schema.String,
});
const ControlRequestSubtype = Schema.Struct({ request: Schema.Struct({ subtype: Schema.String }) });
const ControlCancelRequest = Schema.Struct({
  type: Schema.Literal("control_cancel_request"),
  request_id: Schema.String,
});
const ControlResponse = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({ request_id: Schema.String }),
});
const SdkOnlyMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["control_response", "keep_alive", "transcript_mirror"]) }),
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("session_state_changed"),
    sdk_host_only: Schema.Literal(true),
  }),
]);
const MessageId = Schema.Struct({ uuid: Schema.String });
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const messageKey = (message: Schema.Json): string => {
  if (Schema.is(MessageId)(message)) return message.uuid;
  if (Array.isArray(message)) return serializeVendorValue(message.map(messageKey));
  if (Schema.is(JsonObject)(message))
    return serializeVendorValue(
      Object.entries(message)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, messageKey(value)]),
    );
  return serializeVendorValue(message);
};

const UserInput = Schema.Struct({ type: Schema.Literal("user") });

const LF = 10;
const CR = 13;

/**
 * Splits `buffer` into complete lines and the bytes after the last line break, scanning from
 * `scanned`, the length of the remainder that an earlier call already scanned.
 */
const splitLines = (buffer: Buffer, scanned: number, ends: (byte: number) => boolean) => {
  const lines: Array<Buffer> = [];
  let start = 0;
  for (let index = scanned; index < buffer.length; index++) {
    if (!ends(buffer[index] ?? 0)) continue;
    lines.push(buffer.subarray(start, index));
    start = index + 1;
  }
  return { lines, rest: buffer.subarray(start) };
};

/** Like the SDK's `readline`, Claude stdout lines also end at a lone `\r`. */
const outputLineEnd = (byte: number) => byte === LF || byte === CR;
const inputLineEnd = (byte: number) => byte === LF;

/** A stdout line that the output checkpoint has not passed yet. */
type PendingOutput = {
  /** The line's position in the process output, from 0. */
  readonly line: number;
  /** The line's length, including its line break. */
  readonly bytes: number;
  readonly handled: boolean;
} & (
  | {
      /** A line that the session handles, or that is handled when read. */
      readonly _tag: "Output";
      readonly key: string;
    }
  | {
      /** A control request; only its acknowledged response or its cancellation handles it. */
      readonly _tag: "ControlRequest";
      readonly requestId: string;
      readonly subtype: Option.Option<string>;
      /** Whether a turn result already logged this request as unanswered. */
      readonly reported: boolean;
    }
);

interface CheckpointState {
  /** Stdout bytes after the last line break; earlier reads scanned all of them. */
  readonly output: Buffer;
  /** Acknowledged input bytes after the last line break; earlier calls scanned all of them. */
  readonly input: Buffer;
  /** The number of stdout lines read. */
  readonly lines: number;
  readonly pending: ReadonlyArray<PendingOutput>;
  /** The line of the last message that `handled` marked, or -1. */
  readonly handledThrough: number;
  /** Request IDs whose response input was acknowledged before the request was read. */
  readonly answered: ReadonlySet<string>;
  /** Request IDs released by a cancellation, until the SDK's late response is acknowledged. */
  readonly cancelled: ReadonlySet<string>;
}

/** Removes the handled lines at the start of `pending`; returns their bytes and the rest. */
const flush = (pending: ReadonlyArray<PendingOutput>) => {
  let index = 0;
  let bytes = 0;
  while (pending[index]?.handled === true) bytes += pending[index++]?.bytes ?? 0;
  return { bytes, pending: index === 0 ? pending : pending.slice(index) };
};

/** Marks the unanswered request `requestId` in `pending` handled; returns whether there was one. */
const release = (pending: Array<PendingOutput>, requestId: string) => {
  const index = pending.findIndex(
    (entry) => !entry.handled && entry._tag === "ControlRequest" && entry.requestId === requestId,
  );
  const request = pending[index];
  if (request === undefined) return false;
  pending[index] = { ...request, handled: true };
  return true;
};

const requestFields = (requestId: string, subtype: Option.Option<string>) =>
  Option.match(subtype, {
    onNone: () => ({ requestId }),
    onSome: (subtype) => ({ requestId, subtype }),
  });

/** A decision made while reading stdout, logged after the state update. */
type ReadNote =
  | { readonly _tag: "NonJson"; readonly bytes: number }
  | { readonly _tag: "Cancelled"; readonly requestId: string; readonly released: boolean };

const readOutput =
  (bytes: Uint8Array) =>
  (
    state: CheckpointState,
  ): readonly [
    { readonly bytes: number; readonly notes: ReadonlyArray<ReadNote> },
    CheckpointState,
  ] => {
    const { lines, rest } = splitLines(
      Buffer.concat([state.output, bytes]),
      state.output.length,
      outputLineEnd,
    );
    const pending = [...state.pending];
    const answered = new Set(state.answered);
    const cancelled = new Set(state.cancelled);
    const notes: Array<ReadNote> = [];
    let line = state.lines;
    for (const raw of lines) {
      const text = raw.toString();
      const read = { line: line++, bytes: raw.length + 1 };
      const blank = text.trim() === "";
      const decoded = blank ? Option.none() : decodeMessage(text);
      if (Option.isNone(decoded)) {
        if (!blank) notes.push({ _tag: "NonJson", bytes: read.bytes });
        pending.push({ ...read, _tag: "Output", key: text, handled: true });
        continue;
      }
      const message = decoded.value;
      if (Schema.is(ControlCancelRequest)(message)) {
        const released = release(pending, message.request_id);
        if (released) cancelled.add(message.request_id);
        notes.push({ _tag: "Cancelled", requestId: message.request_id, released });
        pending.push({ ...read, _tag: "Output", key: text, handled: true });
        continue;
      }
      if (Schema.is(ControlRequest)(message)) {
        pending.push({
          ...read,
          _tag: "ControlRequest",
          requestId: message.request_id,
          subtype: Schema.is(ControlRequestSubtype)(message)
            ? Option.some(message.request.subtype)
            : Option.none(),
          reported: false,
          handled: answered.delete(message.request_id),
        });
        continue;
      }
      pending.push({
        ...read,
        _tag: "Output",
        key: messageKey(message),
        handled: Schema.is(SdkOnlyMessage)(message),
      });
    }
    const flushed = flush(pending);
    return [
      { bytes: flushed.bytes, notes },
      { ...state, output: rest, lines: line, pending: flushed.pending, answered, cancelled },
    ];
  };

const acknowledgeInput =
  (bytes: Uint8Array) =>
  (
    state: CheckpointState,
  ): readonly [
    {
      readonly bytes: number;
      readonly userInputs: number;
      /** Request IDs of acknowledged late responses to cancelled requests, which release nothing. */
      readonly lateResponses: ReadonlyArray<string>;
    },
    CheckpointState,
  ] => {
    const { lines, rest } = splitLines(
      Buffer.concat([state.input, bytes]),
      state.input.length,
      inputLineEnd,
    );
    const pending = [...state.pending];
    const answered = new Set(state.answered);
    const cancelled = new Set(state.cancelled);
    const lateResponses: Array<string> = [];
    let userInputs = 0;
    for (const line of lines) {
      const decoded = decodeMessage(line.toString());
      if (Option.isNone(decoded)) continue;
      if (Schema.is(UserInput)(decoded.value)) {
        userInputs++;
        continue;
      }
      if (!Schema.is(ControlResponse)(decoded.value)) continue;
      const id = decoded.value.response.request_id;
      // The SDK's late response to a cancelled request comes before the response to a later
      // request that reuses its ID.
      if (cancelled.delete(id)) lateResponses.push(id);
      else if (!release(pending, id)) answered.add(id);
    }
    const flushed = flush(pending);
    return [
      { bytes: flushed.bytes, userInputs, lateResponses },
      { ...state, input: rest, pending: flushed.pending, answered, cancelled },
    ];
  };

const handleMessage =
  (message: Schema.Json) =>
  (
    state: CheckpointState,
  ): readonly [
    {
      readonly bytes: number;
      readonly unanswered: ReadonlyArray<{ readonly requestId: string; readonly subtype?: string }>;
    },
    CheckpointState,
  ] => {
    const key = messageKey(message);
    const index = state.pending.findIndex(
      (entry) => !entry.handled && entry._tag === "Output" && entry.key === key,
    );
    const entry = state.pending[index];
    if (entry === undefined) return [{ bytes: 0, unanswered: [] }, state];
    const pending = [...state.pending];
    pending[index] = { ...entry, handled: true };
    const unanswered: Array<{ readonly requestId: string; readonly subtype?: string }> = [];
    if (Schema.is(ClaudeResult)(message))
      for (const [at, earlier] of pending.slice(0, index).entries()) {
        if (earlier._tag !== "ControlRequest" || earlier.handled || earlier.reported) continue;
        unanswered.push(requestFields(earlier.requestId, earlier.subtype));
        pending[at] = { ...earlier, reported: true };
      }
    const flushed = flush(pending);
    return [
      { bytes: flushed.bytes, unanswered },
      { ...state, pending: flushed.pending, handledThrough: entry.line },
    ];
  };

/**
 * Tracks which Claude output messages the session handled. Runs `onUserInput` when the process
 * owner acknowledges an input line that carries a user message.
 */
export const claudeOutputCheckpoint = Effect.fn("ClaudeOutputCheckpoint.make")(function* (
  onUserInput: Effect.Effect<void> = Effect.void,
) {
  const state = yield* Ref.make<CheckpointState>({
    output: Buffer.alloc(0),
    input: Buffer.alloc(0),
    lines: 0,
    pending: [],
    handledThrough: -1,
    answered: new Set(),
    cancelled: new Set(),
  });
  return {
    /** Reads stdout bytes; returns the bytes that became checkpointed. */
    read: (bytes: Uint8Array) =>
      Effect.gen(function* () {
        const read = yield* Ref.modify(state, readOutput(bytes));
        for (const note of read.notes)
          yield* Match.valueTags(note, {
            NonJson: ({ bytes }) => Effect.logDebug("Ignoring non-JSON Claude stdout", { bytes }),
            Cancelled: ({ requestId, released }) =>
              Effect.logInfo(
                released
                  ? "Claude cancelled a control request"
                  : "Claude cancelled a control request that is not pending",
                { requestId },
              ),
          });
        return read.bytes;
      }),
    /** Reads input bytes the process owner acknowledged; returns the bytes that became checkpointed. */
    inputAcknowledged: (bytes: Uint8Array) =>
      Effect.gen(function* () {
        const acknowledged = yield* Ref.modify(state, acknowledgeInput(bytes));
        for (const requestId of acknowledged.lateResponses)
          yield* Effect.logInfo(
            "Claude acknowledged the late response to a cancelled control request",
            { requestId },
          );
        for (let index = 0; index < acknowledged.userInputs; index++) yield* onUserInput;
        return acknowledged.bytes;
      }),
    /** Marks `message` handled; returns the bytes that became checkpointed. */
    handled: (message: Schema.Json) =>
      Effect.gen(function* () {
        const handled = yield* Ref.modify(state, handleMessage(message));
        if (handled.unanswered.length > 0)
          yield* Effect.logInfo(
            "Claude finished a turn with unanswered control requests; the output checkpoint stays before them",
            { requests: handled.unanswered },
          );
        return handled.bytes;
      }),
    /** Whether the checkpoint covers every message passed to `handled` and the output read before it. */
    covered: Ref.get(state).pipe(
      Effect.map(({ pending, handledThrough }) => (pending[0]?.line ?? Infinity) > handledThrough),
    ),
  };
});

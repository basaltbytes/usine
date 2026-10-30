import {
  query as openClaudeQuery,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Context, Layer, Schema } from "effect";

/** A user message sent to a Claude Code child through the SDK's streaming input. */
export interface ClaudeUserMessage {
  /** Identifies an input message rather than a harness output event. */
  readonly type: "user";
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

/** The Claude SDK launch options used by the child backend, including worker credentials, settings sources, permissions, and process spawning. */
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
  | "settingSources"
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
>()("@usine/agents/pi/ClaudeSdk") {}

const decodeVendorMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const vendorMessageJson = (message: SDKMessage): Schema.Json =>
  decodeVendorMessage(JSON.stringify(message));

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

export const userMessage = (content: string): ClaudeUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
});

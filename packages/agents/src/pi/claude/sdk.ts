import {
  query as openClaudeQuery,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Context, Layer, Schema } from "effect";

export interface ClaudeUserMessage {
  readonly type: "user";
  readonly message: { readonly role: "user"; readonly content: string };
  readonly parent_tool_use_id: null;
}

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

export interface ClaudeModelInfo {
  readonly value: string;
  readonly resolvedModel?: string;
}

/** A running Claude Code session: its message stream, model list, and stop controls. */
export interface ClaudeQuery extends AsyncIterable<Schema.Json> {
  readonly close: () => void;
  readonly interrupt: () => Promise<void>;
  readonly supportedModels: () => Promise<ReadonlyArray<ClaudeModelInfo>>;
}

/** The service that opens Claude Code sessions. */
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    readonly open: (
      input: AsyncIterable<ClaudeUserMessage>,
      options: ClaudeQueryOptions,
    ) => ClaudeQuery;
  }
>()("@usine/agents/pi/ClaudeSdk") {}

const decodeVendorMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const vendorMessageJson = (message: SDKMessage): Schema.Json =>
  decodeVendorMessage(JSON.stringify(message));

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

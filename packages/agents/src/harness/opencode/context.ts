import type { AgentSession, AgentSessionId, OperatorMessageId } from "@usine/core/agent/session";
import { type Effect, type FiberSet, type Option, Ref } from "effect";
import type { AgentSessionError } from "../../runtime.ts";
import type { sessionConversation } from "../conversation/conversation.ts";
import type { SessionChannel } from "../session.ts";
import type { OpenCodeApi } from "./api.ts";
import type { OpenCodeTokens } from "./codec.ts";
import type { OpenCodeConnection } from "./server.ts";
import type { Execution, Pending } from "./state.ts";

/** What an OpenCode session tracks about its bridge, executions, input, and background work. */
export interface OpenCodeState {
  /** The bridge connection; a process restart replaces it. */
  readonly connection: OpenCodeConnection;
  readonly api: OpenCodeApi;
  readonly execution: Execution;
  readonly pending: Pending;
  /** Tool names by call ID, from `session.tool.input.started`. */
  readonly toolNames: ReadonlyMap<string, string>;
  /** The tool calls that started and haven't finished, by call ID. */
  readonly toolsInFlight: ReadonlyMap<string, string>;
  /** The text of the latest execution's last text part. */
  readonly lastText: Option.Option<string>;
  readonly retries: number;
  readonly retrying: boolean;
  /** Whether the model answered since the current bridge started. */
  readonly answered: boolean;
  /** The cumulative usage of each session in the session's tree, by OpenCode session ID. */
  readonly usage: ReadonlyMap<string, { readonly cost: number; readonly tokens: OpenCodeTokens }>;
}

/** Operator message IDs by the OpenCode message IDs that the session posted them with. */
export type OperatorIds = ReadonlyMap<string, OperatorMessageId>;

/** The shared conversation of an OpenCode session, whose signals are operator message IDs. */
type OpenCodeConversation = Effect.Success<
  ReturnType<typeof sessionConversation<OperatorMessageId>>
>;

/** What the event handlers and the done check of one OpenCode session share. */
export interface OpenCodeContext {
  readonly sessionId: AgentSessionId;
  /** The OpenCode ID of the root session. */
  readonly root: string;
  readonly session: AgentSession;
  readonly state: Ref.Ref<OpenCodeState>;
  /** The API of the current bridge, which a process restart replaces. */
  readonly api: Effect.Effect<OpenCodeApi>;
  readonly conversation: OpenCodeConversation;
  readonly channel: SessionChannel;
  /** The work that runs outside the operation or event that started it. */
  readonly tasks: FiberSet.FiberSet<void>;
  /** Closes the bridge and fails the session with `error`, unless the session is stopping. */
  readonly fail: (error: AgentSessionError) => Effect.Effect<void>;
}

/** Applies `f` to the pending input and background work of `state`. */
export const updatePending = (state: Ref.Ref<OpenCodeState>, f: (pending: Pending) => Pending) =>
  Ref.update(state, (latest): OpenCodeState => ({ ...latest, pending: f(latest.pending) }));

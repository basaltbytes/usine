import {
  AgentSession,
  AgentSessionId,
  HarnessSession,
  type SessionTokensUpdated,
} from "@usine/core/agent/session";
import { MachineId, WorkerName } from "@usine/core/worker";
import { type Brand, type Effect, Schema } from "effect";
import { ChildHost } from "../child-host/child-host.ts";
import {
  AgentCapacityError,
  type AgentSessionError,
  type InterruptedTool,
  type RunningSession,
  SessionOperationError,
  WorkingDirectory,
} from "../runtime.ts";
import { AdmittedBrain } from "./admission.ts";

/**
 * What a harness session runs and where. A role builds the spec; an adapter only reads it, so an
 * adapter never branches on the role and the spec names no harness beyond the brain.
 */
export class SessionSpec extends Schema.Class<
  SessionSpec,
  Brand.Brand<"@usine/agents/harness/contract/SessionSpec">
>("@usine/agents/SessionSpec")({
  /** The usine identity and brain that the session's events carry. */
  session: AgentSession,
  /** The role, placement, credential route, and billing pool that admission resolved. */
  admitted: AdmittedBrain,
  /** Where to start the harness process and run its commands. */
  host: ChildHost,
  /** The worker that `host` runs on. */
  worker: WorkerName,
  /** The provisioned machine that `host` runs on, or `None` on a worker with a shared login. */
  machine: Schema.Option(MachineId),
  /** The checkout directory on `host`. */
  cwd: WorkingDirectory,
  /**
   * The complete environment of the harness process and its commands, with nothing inherited from
   * the launching process (ADR 0011).
   */
  environment: Schema.Record(Schema.String, Schema.String),
}) {}

/** Starts a new conversation with `text` as its first message. */
export class StartPrompt extends Schema.TaggedClass<
  StartPrompt,
  Brand.Brand<"@usine/agents/harness/contract/StartPrompt">
>("@usine/agents/StartPrompt")("StartPrompt", {
  text: Schema.NonEmptyString,
}) {}

/** Reopens the saved conversation `reference` without sending a message. */
export class StartResume extends Schema.TaggedClass<
  StartResume,
  Brand.Brand<"@usine/agents/harness/contract/StartResume">
>("@usine/agents/StartResume")("StartResume", {
  reference: HarnessSession,
}) {}

/** How `HarnessRuntime.open` starts a session. */
export const Start = Schema.Union([StartPrompt, StartResume]);
export type Start = typeof Start.Type;

/**
 * An open native session. `active` reports whether a reopened process was already in a turn, so
 * recovery starts none.
 */
export interface NativeSession {
  readonly running: RunningSession;
  readonly active: boolean;
  /** Closes `tools` as interrupted and applies the continuation decision. */
  readonly recover: (
    tools: ReadonlyArray<InterruptedTool>,
  ) => Effect.Effect<void, AgentSessionError>;
}

/**
 * The schema of a structured completion's value. Its JSON form must be an object, so that every
 * harness can constrain the model to it; give every field a value, because OpenAI's strict mode
 * requires every property.
 */
export type CompletionOutput<A> = Schema.Codec<A, unknown, never, unknown>;

/**
 * A schema-checked value from `HarnessRuntime.complete`. A completion saves no conversation, so it
 * has no session reference.
 */
export interface Completion<A> {
  readonly value: A;
  /**
   * The completion's tokens and cost, reported as for a session: its `session` carries the brain
   * that the harness ran and the billing pool that paid for it.
   */
  readonly usage: SessionTokensUpdated;
}

/** The harness returned a value that the output schema rejects, or no value. */
export class CompletionInvalid extends Schema.TaggedError<
  CompletionInvalid,
  Brand.Brand<"@usine/agents/harness/contract/CompletionInvalid">
>("@usine/agents/CompletionInvalid")("CompletionInvalid", {
  sessionId: AgentSessionId,
  message: Schema.NonEmptyString,
}) {}

/**
 * Admission, the harness, or its model refused the request: the brain can't serve the role, the
 * model or credential isn't available, or the model declined to answer. The same request fails
 * the same way until its brain, credential, or prompt changes.
 */
export class CompletionRefused extends Schema.TaggedError<
  CompletionRefused,
  Brand.Brand<"@usine/agents/harness/contract/CompletionRefused">
>("@usine/agents/CompletionRefused")("CompletionRefused", {
  sessionId: AgentSessionId,
  message: Schema.NonEmptyString,
}) {}

/**
 * Why a structured completion has no value. `AgentCapacityError` is a provider capacity refusal or
 * usage limit, and `SessionOperationError` a harness process or transport failure.
 */
export const CompletionError = Schema.Union([
  CompletionInvalid,
  CompletionRefused,
  AgentCapacityError,
  SessionOperationError,
]);
export type CompletionError = typeof CompletionError.Type;

import { AgentSession, HarnessSession } from "@usine/core/agent/session";
import { MachineId, WorkerName } from "@usine/core/worker";
import { type Brand, type Effect, Schema } from "effect";
import { ChildHost } from "../child-host/child-host.ts";
import {
  type AgentSessionError,
  type InterruptedTool,
  type RunningSession,
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

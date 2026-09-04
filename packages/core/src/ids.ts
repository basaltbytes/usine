import { Schema } from "effect";

/** Identity of one Attempt. */
export const AttemptId = Schema.NonEmptyString.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptId.Type;

/** Identity of one Run. */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

/** Identity of one Event in the ledger. */
export const EventId = Schema.NonEmptyString.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

/**
 * The engine-derived, never-expiring idempotency key — timestamps aside, the
 * same watched state is the same Event, forever. Derived per trigger type,
 * never authored in a loop file (ADR 0002).
 */
export const DedupKey = Schema.NonEmptyString.pipe(Schema.brand("DedupKey"));
export type DedupKey = typeof DedupKey.Type;

/**
 * Stable identity of one piece of software-work state inside a loop. Several
 * content-distinct Events may concern the same Item.
 */
export const ItemKey = Schema.NonEmptyString.pipe(Schema.brand("ItemKey"));
export type ItemKey = typeof ItemKey.Type;

/**
 * Step identity within its run — the loop-authored name (ADR 0002). Renaming a
 * step in the loop file retires it — prior results stay under the old name.
 * There is deliberately no synthetic step id.
 */
export const StepName = Schema.NonEmptyString.pipe(Schema.brand("StepName"));
export type StepName = typeof StepName.Type;

/**
 * Loop identity — the loop file's name in the instance repo. Filename is
 * identity — renaming the file retires one loop and creates another
 * (ADR 0001).
 */
export const LoopName = Schema.NonEmptyString.pipe(Schema.brand("LoopName"));
export type LoopName = typeof LoopName.Type;

/** The filename-keyed identity of one rostered Agent. */
export const AgentName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case Agent name",
  }),
).pipe(Schema.brand("AgentName"));
export type AgentName = typeof AgentName.Type;

/** The name-keyed identity of a configured Worker. */
export const WorkerName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
    message: "Expected a kebab-case Worker name",
  }),
).pipe(Schema.brand("WorkerName"));
export type WorkerName = typeof WorkerName.Type;

/**
 * The stable `owner/name` identity shared by the registry and every
 * GitHub-facing block. The original casing is significant to display; GitHub
 * comparisons are handled separately at the adapter boundary.
 */
export const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, {
    message: "Expected a full GitHub repo name (owner/name)",
  }),
).pipe(Schema.brand("RepoName"));
export type RepositoryName = typeof RepositoryName.Type;

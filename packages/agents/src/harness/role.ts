import { RoleName } from "@usine/core/agent/session";
import { type Brand, Schema } from "effect";
import { type Capability, CredentialRoute, Placement } from "./capability.ts";

/** The placements that a role runs at, and why it refuses every other placement. */
export class RolePlacements extends Schema.Class<
  RolePlacements,
  Brand.Brand<"@usine/agents/harness/role/RolePlacements">
>("@usine/agents/RolePlacements")({
  placements: Schema.NonEmptyArray(Placement),
  reason: Schema.NonEmptyString,
}) {}

/** The credential routes that a role accepts, and why it refuses every other route. */
export class RoleCredentials extends Schema.Class<
  RoleCredentials,
  Brand.Brand<"@usine/agents/harness/role/RoleCredentials">
>("@usine/agents/RoleCredentials")({
  credentials: Schema.NonEmptyArray(CredentialRoute),
  reason: Schema.NonEmptyString,
}) {}

/**
 * Which of the harness's own tools a role keeps. `none` turns them all off. `read` keeps only the
 * tools that read and search files, on a harness that lists its tools exactly; a harness that
 * can't keeps all its own tools, and admission reports why. `all` keeps every tool.
 */
export const NativeTools = Schema.Literals(["none", "read", "all"]);
export type NativeTools = typeof NativeTools.Type;

/**
 * What a role keeps of its conversation. `saved` keeps a conversation that a later session can
 * reopen. `journaled` runs the session inside usine's durable journal, which supplies its tools and
 * commits their intents and results, so a tool call continues after an orchestrator restart.
 * `ephemeral` keeps nothing.
 */
const RolePersistence = Schema.Literals(["saved", "journaled", "ephemeral"]);
type RolePersistence = typeof RolePersistence.Type;

/**
 * What a role needs from the session it runs in. A role states its needs here, and admission
 * derives the harness capabilities from them with `requirements`, so a new role needs no change to
 * admission.
 */
export class RoleSpec extends Schema.Class<
  RoleSpec,
  Brand.Brand<"@usine/agents/harness/role/RoleSpec">
>("@usine/agents/RoleSpec")({
  name: RoleName,
  placement: RolePlacements,
  /** `None` accepts every route that the harness offers at the placement. */
  credential: Schema.Option(RoleCredentials),
  nativeTools: NativeTools,
  /** Whether the session runs a tool set that usine supplies. */
  hostTools: Schema.Boolean,
  persistence: RolePersistence,
  /** Whether operators and usine steer, interrupt, and message the session while it runs. */
  interventions: Schema.Boolean,
  /** `structured` returns one schema-checked value instead of text. */
  output: Schema.Literals(["text", "structured"]),
}) {}

const persistenceRequirements = {
  saved: [],
  journaled: ["durable-coordination"],
  ephemeral: ["ephemeral"],
} satisfies Record<RolePersistence, ReadonlyArray<Capability>>;

/**
 * The harness capabilities that `role` needs for a session. Every session needs `token-usage`,
 * and a session that reopens a saved conversation needs `resume-session`. A journaled session
 * takes its tools from the journal, so `durable-coordination` replaces `usine-tools` and
 * `closed-tools`. A role that keeps only `read` tools doesn't require `closed-tools`.
 */
export const requirements = (
  role: RoleSpec,
  options: { readonly reopens: boolean } = { reopens: false },
): ReadonlyArray<Capability> => {
  const contractTools = role.persistence !== "journaled";
  return [
    ...(contractTools && role.hostTools ? (["usine-tools"] as const) : []),
    ...(contractTools && role.nativeTools === "none" ? (["closed-tools"] as const) : []),
    ...(role.output === "structured" ? (["structured-output"] as const) : []),
    ...persistenceRequirements[role.persistence],
    ...(options.reopens ? (["resume-session"] as const) : []),
    ...(role.interventions ? (["steer", "interrupt"] as const) : []),
    "token-usage",
  ];
};

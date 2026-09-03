import {
  Agent as CoreAgent,
  Loop as CoreLoop,
  Repository,
  Step,
  Worker as CoreWorker,
} from "@usine/core";
import { Source } from "@usine/expression";
import { Cron as EffectCron, DateTime, Effect, Option, Result, Schema } from "effect";

/** Instance-relative path of one authored file (`usine.yaml`, `loops/x.md`). */
export const InstancePath = Schema.NonEmptyString.pipe(Schema.brand("InstancePath"));
export type InstancePath = typeof InstancePath.Type;

export const FileStage = Schema.Literals([
  "expression",
  "frontmatter",
  "read",
  "reference",
  "schema",
  "yaml",
]);
export type FileStage = typeof FileStage.Type;

/** One precise, file-owned config failure suitable for quarantine UI. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>(
  "@usine/config/ConfigFileError",
)("ConfigFileError", {
  file: InstancePath,
  stage: FileStage,
  expression: Schema.OptionFromOptionalKey(Source),
  message: Schema.NonEmptyString,
}) {}

/** A factory-level failure: the registry/settings boundary could not be loaded. */
export class FactoryConfigError extends Schema.TaggedError<FactoryConfigError>(
  "@usine/config/FactoryConfigError",
)("FactoryConfigError", {
  file: InstancePath,
  stage: FileStage,
  message: Schema.NonEmptyString,
}) {}

/** Every failure mode this package's parsers and loaders can produce. */
export const ConfigError = Schema.Union([ConfigFileError, FactoryConfigError]);
export type ConfigError = typeof ConfigError.Type;

const KebabCase = Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
  message: "Expected a kebab-case filename identity",
});

const nonBlankString = (message: string) =>
  Schema.String.check(Schema.isPattern(/\S/u, { message }));

export const AgentName = CoreAgent.Name;
export type AgentName = CoreAgent.Name;

export const LoopName = CoreLoop.LoopName.check(KebabCase);
export type LoopName = typeof LoopName.Type;

export const WorkerName = CoreWorker.Name;
export type WorkerName = CoreWorker.Name;

export const RepoName = Repository.Name;
export type RepoName = Repository.Name;

export const RegistryTag = nonBlankString("Expected a non-blank registry tag").pipe(
  Schema.brand("RegistryTag"),
);
export type RegistryTag = typeof RegistryTag.Type;

export const LaneName = nonBlankString("Expected a non-blank lane name").pipe(
  Schema.brand("LaneName"),
);
export type LaneName = typeof LaneName.Type;

export const GitHubLabelName = nonBlankString("Expected a non-blank GitHub label name").pipe(
  Schema.brand("GitHubLabelName"),
);
export type GitHubLabelName = typeof GitHubLabelName.Type;

export const LaneItemState = Schema.Literals([
  "issue-open",
  "issue-closed",
  "pr-open",
  "pr-closed",
  "pr-merged",
]);
export type LaneItemState = typeof LaneItemState.Type;

export class LabelLaneSource extends Schema.Class<LabelLaneSource>("@usine/config/LabelLaneSource")(
  {
    label: GitHubLabelName,
  },
) {}

export class StateLaneSource extends Schema.Class<StateLaneSource>("@usine/config/StateLaneSource")(
  {
    state: LaneItemState,
  },
) {}

export const LaneSource = Schema.Union([LabelLaneSource, StateLaneSource]);
export type LaneSource = typeof LaneSource.Type;

export class Lane extends Schema.Class<Lane>("@usine/config/Lane")({
  name: LaneName,
  sources: Schema.Array(LaneSource).check(Schema.isNonEmpty()),
}) {}

export const ModelId = CoreAgent.ModelId;
export type ModelId = CoreAgent.ModelId;

export const OperatorLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u, {
    message: "Expected a GitHub login",
  }),
).pipe(Schema.brand("OperatorLogin"));
export type OperatorLogin = typeof OperatorLogin.Type;

export const PromptTemplate = nonBlankString("Expected a non-blank Markdown prompt").pipe(
  Schema.brand("PromptTemplate"),
);
export type PromptTemplate = typeof PromptTemplate.Type;

export const Persona = CoreAgent.Persona;
export type Persona = CoreAgent.Persona;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const uniqueNames = Schema.makeFilter<ReadonlyArray<{ readonly name: string }>>(
  (values) => new Set(values.map(({ name }) => name)).size === values.length,
  { message: "Expected unique names" },
);

const laneSourceKey = (source: LaneSource): string =>
  "label" in source ? `label:${source.label}` : `state:${source.state}`;

const uniqueLaneSources = Schema.makeFilter<ReadonlyArray<Lane>>(
  (lanes) => {
    const keys = lanes.flatMap(({ sources }) => sources.map(laneSourceKey));
    return new Set(keys).size === keys.length;
  },
  { message: "Expected every lane source to be mapped once" },
);

const Lanes = Schema.Array(Lane).check(uniqueNames, uniqueLaneSources);

export class ManagedRepo extends Schema.Class<ManagedRepo>("@usine/config/ManagedRepo")({
  name: RepoName,
  tags: Schema.Array(RegistryTag)
    .check(Schema.isUnique())
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  lanes: Lanes.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

export const WorkerKind = CoreWorker.Kind;
export type WorkerKind = CoreWorker.Kind;

export class Worker extends Schema.Class<Worker>("@usine/config/Worker")({
  name: WorkerName,
  kind: WorkerKind,
  maxConcurrentAttempts: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
}) {}

export class Settings extends Schema.Class<Settings>("@usine/config/Settings")({
  pollInterval: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  /** Total child sessions one Attempt may spawn; this is not a concurrency limit. */
  maxChildren: CoreAgent.ChildSessionBudget.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  maxAttemptMinutes: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  maxAttemptTokens: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(10_000_000))),
  parentModel: Schema.OptionFromOptionalKey(ModelId),
}) {}

export const Webhooks = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("off") }),
  Schema.Struct({ mode: Schema.Literal("deliveries") }),
  Schema.Struct({ mode: Schema.Literal("endpoint"), publicUrl: Schema.URLFromString }).pipe(
    Schema.encodeKeys({ publicUrl: "public_url" }),
  ),
]);
export type Webhooks = typeof Webhooks.Type;

// The authored YAML surface is snake_case; domain fields are camelCase. The
// renames live here, at the parse boundary, and encode back for edits.
const SettingsFromYaml = Settings.pipe(
  Schema.encodeKeys({
    pollInterval: "poll_interval",
    maxChildren: "max_children",
    maxAttemptMinutes: "max_attempt_minutes",
    maxAttemptTokens: "max_attempt_tokens",
    parentModel: "parent_model",
  }),
);
const WorkerFromYaml = Worker.pipe(
  Schema.encodeKeys({ maxConcurrentAttempts: "max_concurrent_attempts" }),
);

const ManagedRepos = Schema.Array(ManagedRepo).check(uniqueNames);
const Workers = Schema.Array(WorkerFromYaml).check(Schema.isNonEmpty(), uniqueNames);

/** Strict, factory-wide authored config from usine.yaml. */
export class UsineConfig extends Schema.Class<UsineConfig>("@usine/config/UsineConfig")({
  version: Schema.Literal(1),
  repos: ManagedRepos,
  settings: SettingsFromYaml.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  workers: Workers.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([{ name: "local", kind: "local" }])),
  ),
  webhooks: Webhooks.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ mode: "off" }))),
  operator: Schema.OptionFromOptionalKey(OperatorLogin),
}) {}

export class Selector extends Schema.Class<Selector>("@usine/config/Selector")({
  repos: Schema.OptionFromOptionalKey(
    Schema.Array(RepoName).check(Schema.isNonEmpty(), Schema.isUnique()),
  ),
  tags: Schema.OptionFromOptionalKey(
    Schema.Array(RegistryTag).check(Schema.isNonEmpty(), Schema.isUnique()),
  ),
}) {}

export const ValidSelector = Selector.check(
  Schema.makeFilter((selector) => Option.isSome(selector.repos) || Option.isSome(selector.tags), {
    message: "Expected selector.repos, selector.tags, or both",
  }),
);

// Validated by the same effect Cron parser the engine's scheduler evaluates
// with, so a cron that parses here parses at tick time too. Evaluation is a
// weaker guarantee: Cron.prev/next can still fail inside a DST gap, which the
// scheduler isolates per schedule.
const isFiveFieldCron = (value: string): boolean =>
  value.trim().split(/\s+/u).length === 5 && Result.isSuccess(EffectCron.parse(value));

export const Cron = Schema.String.check(
  Schema.makeFilter(isFiveFieldCron, { message: "Expected a valid five-field cron expression" }),
).pipe(Schema.brand("Cron"));
export type Cron = typeof Cron.Type;

const isTimeZone = (value: string): boolean => Option.isSome(DateTime.zoneMakeNamed(value));

export const TimeZone = Schema.String.check(
  Schema.makeFilter(isTimeZone, { message: "Expected an IANA time-zone name" }),
).pipe(Schema.brand("TimeZone"));
export type TimeZone = typeof TimeZone.Type;

export class IssueTrigger extends Schema.Class<IssueTrigger>("@usine/config/IssueTrigger")({
  on: Schema.Literal("issue"),
  if: Source,
}) {}

export class PullRequestTrigger extends Schema.Class<PullRequestTrigger>(
  "@usine/config/PullRequestTrigger",
)({
  on: Schema.Literal("pr"),
  if: Source,
}) {}

export class ScheduleTrigger extends Schema.Class<ScheduleTrigger>("@usine/config/ScheduleTrigger")(
  {
    on: Schema.Literal("schedule"),
    if: Source,
    cron: Cron,
    tz: TimeZone.pipe(Schema.withDecodingDefaultKey(Effect.succeed("UTC"))),
  },
) {}

export const Trigger = Schema.Union([IssueTrigger, PullRequestTrigger, ScheduleTrigger]);
export type Trigger = typeof Trigger.Type;

/** The watched streams, derived from the Trigger union so the set has one owner. */
export type Stream = Trigger["on"];

export class LoopFile extends Schema.Class<LoopFile>("@usine/config/LoopFile")({
  name: LoopName,
  trigger: Trigger,
  selector: Schema.Option(ValidSelector),
  approval: CoreLoop.ApprovalRequirement,
  step: Step.StepName,
  agent: AgentName,
  body: PromptTemplate,
}) {}

export const Harness = CoreAgent.Harness;
export type Harness = CoreAgent.Harness;

export const Effort = CoreAgent.Effort;
export type Effort = CoreAgent.Effort;

export class AgentFile extends Schema.Class<AgentFile>("@usine/config/AgentFile")({
  name: AgentName,
  harness: Harness,
  model: ModelId,
  effort: Effort,
  parentModel: Schema.Option(ModelId),
  persona: Persona,
}) {}

export class InvalidAgent extends Schema.Class<InvalidAgent>("@usine/config/InvalidAgent")({
  file: InstancePath,
  error: ConfigFileError,
}) {}

export class QuarantinedLoop extends Schema.Class<QuarantinedLoop>("@usine/config/QuarantinedLoop")(
  {
    file: InstancePath,
    error: ConfigFileError,
  },
) {}

/** The instance-relative path a loop's filename identity maps back to. */
export const loopPath = (name: LoopName): InstancePath => InstancePath.make(`loops/${name}.md`);

/** The names a loop may reference, drawn from one loaded roster and registry. */
export interface ReferenceIndex {
  readonly agentNames: ReadonlySet<AgentName>;
  readonly registryTags: ReadonlySet<RegistryTag>;
  readonly repoNames: ReadonlySet<RepoName>;
}

export const referenceIndex = (
  config: UsineConfig,
  agents: ReadonlyArray<AgentFile>,
): ReferenceIndex => ({
  agentNames: new Set(agents.map(({ name }) => name)),
  registryTags: new Set(config.repos.flatMap(({ tags }) => tags)),
  repoNames: new Set(config.repos.map(({ name }) => name)),
});

/**
 * Pure deriver: the reference failure quarantining one loop against the
 * loaded roster and registry, if any. The single owner of the reference rule
 * — the folder loader reports it per file, LoadedInstance enforces it at
 * construction.
 */
export const loopReferenceFailure = (
  file: InstancePath,
  loop: LoopFile,
  references: ReferenceIndex,
): Option.Option<ConfigFileError> => {
  const referenceError = (message: string): Option.Option<ConfigFileError> =>
    Option.some(
      new ConfigFileError({ file, stage: "reference", expression: Option.none(), message }),
    );
  if (!references.agentNames.has(loop.agent)) {
    return referenceError(`Unknown agent: ${loop.agent}`);
  }

  if (Option.isNone(loop.selector)) return Option.none();
  if (Option.isSome(loop.selector.value.repos)) {
    const missing = loop.selector.value.repos.value.filter(
      (name) => !references.repoNames.has(name),
    );
    if (missing.length > 0) {
      return referenceError(`Unknown selector repos: ${missing.join(", ")}`);
    }
  }

  if (Option.isSome(loop.selector.value.tags)) {
    const missing = loop.selector.value.tags.value.filter(
      (tag) => !references.registryTags.has(tag),
    );
    if (missing.length > 0) {
      return referenceError(`Unknown selector tags: ${missing.join(", ")}`);
    }
  }
  return Option.none();
};

/** One atomic snapshot of an instance folder. Loops with unresolved references are unconstructible. */
export class LoadedInstance extends Schema.Class<LoadedInstance>("@usine/config/LoadedInstance")(
  Schema.Struct({
    config: UsineConfig,
    agents: Schema.Array(AgentFile),
    invalidAgents: Schema.Array(InvalidAgent),
    loops: Schema.Array(LoopFile),
    quarantinedLoops: Schema.Array(QuarantinedLoop),
  }).check(
    Schema.makeFilter(
      ({ agents, config, loops }) => {
        const references = referenceIndex(config, agents);
        return loops.every((loop) =>
          Option.isNone(loopReferenceFailure(loopPath(loop.name), loop, references)),
        );
      },
      { message: "Expected every loop to reference the loaded roster and registry" },
    ),
  ),
) {}

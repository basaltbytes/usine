import { Loop as CoreLoop, Step } from "@usine/core";
import { Source } from "@usine/expression";
import { Effect, Option, Schema } from "effect";
import { ConfigFileError } from "./errors.ts";

const KebabCase = Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
  message: "Expected a kebab-case filename identity",
});

const Slug = Schema.String.check(KebabCase);

const nonBlankString = (message: string) =>
  Schema.String.check(Schema.isPattern(/\S/u, { message }));

export const AgentName = Slug.pipe(Schema.brand("AgentName"));
export type AgentName = typeof AgentName.Type;

export const LoopName = CoreLoop.LoopName.check(KebabCase);
export type LoopName = typeof LoopName.Type;

export const WorkerName = Slug.pipe(Schema.brand("WorkerName"));
export type WorkerName = typeof WorkerName.Type;

export const RepoName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, {
    message: "Expected a full GitHub repo name (owner/name)",
  }),
).pipe(Schema.brand("RepoName"));
export type RepoName = typeof RepoName.Type;

export const RegistryTag = nonBlankString("Expected a non-blank registry tag").pipe(
  Schema.brand("RegistryTag"),
);
export type RegistryTag = typeof RegistryTag.Type;

export const ModelId = nonBlankString("Expected a non-blank model id").pipe(
  Schema.brand("ModelId"),
);
export type ModelId = typeof ModelId.Type;

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

export const Persona = nonBlankString("Expected a non-blank Markdown persona").pipe(
  Schema.brand("Persona"),
);
export type Persona = typeof Persona.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const uniqueNames = Schema.makeFilter<ReadonlyArray<{ readonly name: string }>>(
  (values) => new Set(values.map(({ name }) => name)).size === values.length,
  { message: "Expected unique names" },
);

export class ManagedRepo extends Schema.Class<ManagedRepo>("Config/ManagedRepo")({
  name: RepoName,
  tags: Schema.Array(RegistryTag)
    .check(Schema.isUnique())
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

export const WorkerKind = Schema.Literals(["local", "exe.dev"]);
export type WorkerKind = typeof WorkerKind.Type;

export class Worker extends Schema.Class<Worker>("Config/Worker")({
  name: WorkerName,
  kind: WorkerKind,
  maxConcurrentAttempts: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
}) {}

export class Settings extends Schema.Class<Settings>("Config/Settings")({
  poll_interval: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  max_children: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(4))),
  max_attempt_minutes: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(60))),
  max_attempt_tokens: PositiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(10_000_000))),
  parent_model: Schema.OptionFromOptionalKey(ModelId),
}) {}

export const Webhooks = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("off") }),
  Schema.Struct({ mode: Schema.Literal("deliveries") }),
  Schema.Struct({ mode: Schema.Literal("endpoint"), public_url: Schema.URLFromString }),
]);
export type Webhooks = typeof Webhooks.Type;

const ManagedRepos = Schema.Array(ManagedRepo).check(uniqueNames);
const Workers = Schema.Array(Worker).check(uniqueNames);

/** Strict, factory-wide authored config from usine.yaml. */
export class UsineConfig extends Schema.Class<UsineConfig>("Config/UsineConfig")({
  version: Schema.Literal(1),
  repos: ManagedRepos,
  settings: Settings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  workers: Workers.pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed([{ name: "local", kind: "local", maxConcurrentAttempts: 1 }]),
    ),
  ),
  webhooks: Webhooks.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ mode: "off" }))),
  operator: Schema.OptionFromOptionalKey(OperatorLogin),
}) {}

export class Selector extends Schema.Class<Selector>("Config/Selector")({
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

const cronField = (field: string, minimum: number, maximum: number): boolean =>
  field.split(",").every((part) => {
    const stepParts = part.split("/");
    if (stepParts.length > 2) return false;
    const [range = "", stepText] = stepParts;
    if (stepText !== undefined) {
      const step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) return false;
    }
    if (range === "*") return true;
    const rangeParts = range.split("-");
    if (rangeParts.length > 2) return false;
    const [startText = "", endText] = rangeParts;
    if (startText.length === 0 || endText === "") return false;
    const start = Number(startText);
    if (!Number.isInteger(start) || start < minimum || start > maximum) return false;
    if (endText === undefined) return true;
    const end = Number(endText);
    return Number.isInteger(end) && end >= start && end <= maximum;
  });

const isFiveFieldCron = (value: string): boolean => {
  const fields = value.trim().split(/\s+/u);
  return (
    fields.length === 5 &&
    cronField(fields[0] ?? "", 0, 59) &&
    cronField(fields[1] ?? "", 0, 23) &&
    cronField(fields[2] ?? "", 1, 31) &&
    cronField(fields[3] ?? "", 1, 12) &&
    cronField(fields[4] ?? "", 0, 7)
  );
};

export const Cron = Schema.String.check(
  Schema.makeFilter(isFiveFieldCron, { message: "Expected a valid five-field cron expression" }),
).pipe(Schema.brand("Cron"));
export type Cron = typeof Cron.Type;

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

export const TimeZone = Schema.String.check(
  Schema.makeFilter(isTimeZone, { message: "Expected an IANA time-zone name" }),
).pipe(Schema.brand("TimeZone"));
export type TimeZone = typeof TimeZone.Type;

export class IssueTrigger extends Schema.Class<IssueTrigger>("Config/IssueTrigger")({
  on: Schema.Literal("issue"),
  if: Source,
}) {}

export class PullRequestTrigger extends Schema.Class<PullRequestTrigger>(
  "Config/PullRequestTrigger",
)({
  on: Schema.Literal("pr"),
  if: Source,
}) {}

export class ScheduleTrigger extends Schema.Class<ScheduleTrigger>("Config/ScheduleTrigger")({
  on: Schema.Literal("schedule"),
  if: Source,
  cron: Cron,
  tz: TimeZone.pipe(Schema.withDecodingDefaultKey(Effect.succeed("UTC"))),
}) {}

export const Trigger = Schema.Union([IssueTrigger, PullRequestTrigger, ScheduleTrigger]);
export type Trigger = typeof Trigger.Type;

export const Stream = Schema.Literals(["issue", "pr", "schedule"]);
export type Stream = typeof Stream.Type;

export const Approval = Schema.Literals(["none", "required"]);
export type Approval = typeof Approval.Type;

export class LoopFile extends Schema.Class<LoopFile>("Config/LoopFile")({
  name: LoopName,
  trigger: Trigger,
  selector: Schema.Option(ValidSelector),
  approval: Approval,
  step: Step.StepName,
  agent: AgentName,
  body: PromptTemplate,
}) {}

export const Harness = Schema.Literals(["claude", "codex", "pi"]);
export type Harness = typeof Harness.Type;

export const Effort = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

export class AgentFile extends Schema.Class<AgentFile>("Config/AgentFile")({
  name: AgentName,
  harness: Harness,
  model: ModelId,
  effort: Effort,
  parentModel: Schema.Option(ModelId),
  persona: Persona,
}) {}

export class InvalidAgent extends Schema.Class<InvalidAgent>("Config/InvalidAgent")({
  file: Schema.NonEmptyString,
  error: ConfigFileError,
}) {}

export class QuarantinedLoop extends Schema.Class<QuarantinedLoop>("Config/QuarantinedLoop")({
  file: Schema.NonEmptyString,
  error: ConfigFileError,
}) {}

/** One atomic snapshot of an instance folder. */
export class LoadedInstance extends Schema.Class<LoadedInstance>("Config/LoadedInstance")({
  config: UsineConfig,
  agents: Schema.Array(AgentFile),
  invalidAgents: Schema.Array(InvalidAgent),
  loops: Schema.Array(LoopFile),
  quarantinedLoops: Schema.Array(QuarantinedLoop),
}) {}

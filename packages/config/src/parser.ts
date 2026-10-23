import { StepName } from "@usine/core/step";
import { ApprovalRequirement, LoopName } from "@usine/core/loop";
import {
  ExpressionEngine,
  type Environment,
  type ExpressionCheckError,
  type ExpressionError,
  Source,
} from "@usine/expression/expression-engine";
import { Context, Effect, Layer, Option, Schema, SchemaGetter, SchemaIssue, Struct } from "effect";
import { splitMarkdown } from "./frontmatter.ts";
import { AgentFile } from "./agent.ts";
import { canonicalLabelName, GitHubLabelName } from "./label.ts";
import { ConfigFileError, InstancePath } from "./file.ts";
import {
  type ConfigWarning,
  UndeclaredLaneLabelWarning,
  UndeclaredTriggerLabelWarning,
} from "./instance/diagnostics.ts";
import { LoopFile, loopPath, PromptTemplate } from "./loop.ts";
import { AgentPersona, AgentName } from "@usine/core/agent";
import { IssueTrigger, PullRequestTrigger, ScheduleTrigger } from "./trigger.ts";
import { UsineConfig } from "./factory.ts";
import { ValidSelector } from "./selector.ts";
import { Effort, Harness, ModelId } from "@usine/core/agent/brain";
import { environmentFor } from "./payload-slices.ts";
import { parseYamlDocument } from "./yaml/document.ts";

const formatIssue = SchemaIssue.makeFormatterDefault();

// YAML reads an unquoted `if: true` as a boolean; it decodes to the same CEL literal.
const ConditionFromYaml = Schema.Union([Schema.String, Schema.Boolean])
  .annotate({ message: "Expected a CEL expression: quote the value so YAML reads it as a string" })
  .pipe(
    Schema.decodeTo(Source, {
      decode: SchemaGetter.transform((condition: string | boolean) => String(condition)),
      encode: SchemaGetter.transform((condition: string) => condition),
    }),
  );

const TriggerFromYaml = Schema.Union([
  IssueTrigger.mapFields(Struct.assign({ if: ConditionFromYaml })).pipe(
    Schema.decodeTo(IssueTrigger),
  ),
  PullRequestTrigger.mapFields(Struct.assign({ if: ConditionFromYaml })).pipe(
    Schema.decodeTo(PullRequestTrigger),
  ),
  ScheduleTrigger.mapFields(Struct.assign({ if: ConditionFromYaml })).pipe(
    Schema.decodeTo(ScheduleTrigger),
  ),
]);

class LoopFrontmatter extends Schema.Class<LoopFrontmatter>("@usine/config/LoopFrontmatter")({
  trigger: TriggerFromYaml,
  selector: Schema.OptionFromOptionalKey(ValidSelector),
  approval: ApprovalRequirement.pipe(Schema.withDecodingDefaultKey(Effect.succeed("none"))),
  step: StepName.pipe(Schema.withDecodingDefaultKey(Effect.succeed("run"))),
  agent: AgentName,
  maxCycles: LoopFile.fields.maxCycles,
  permissions: LoopFile.fields.permissions,
}) {}

const AuthoredLoopFrontmatter = LoopFrontmatter.pipe(
  Schema.encodeKeys({ maxCycles: "max_cycles" }),
);

class AgentFrontmatter extends Schema.Class<AgentFrontmatter>("@usine/config/AgentFrontmatter")({
  harness: Harness,
  model: ModelId,
  effort: Effort,
  parentModel: Schema.OptionFromOptionalKey(ModelId),
  parentEffort: Schema.OptionFromOptionalKey(Effort),
}) {}

const AuthoredAgentFrontmatter = AgentFrontmatter.pipe(
  Schema.encodeKeys({ parentModel: "parent_model", parentEffort: "parent_effort" }),
);

interface Interpolation {
  readonly source: Source;
  readonly start: number;
  readonly end: number;
}

const schemaError = (file: InstancePath, error: Schema.SchemaError): ConfigFileError =>
  new ConfigFileError({
    file,
    stage: "schema",
    expression: Option.none(),
    message: formatIssue(error.issue),
  });

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

const parseYaml = (
  file: InstancePath,
  source: string,
): Effect.Effect<Schema.Json, ConfigFileError> =>
  Effect.gen(function* () {
    const document = yield* parseYamlDocument(file, source);
    return yield* decodeJson(document.toJS()).pipe(
      Effect.mapError(
        (error) =>
          new ConfigFileError({
            file,
            stage: "yaml",
            expression: Option.none(),
            message: formatIssue(error.issue),
          }),
      ),
    );
  });

const expressionError = (file: InstancePath, error: ExpressionError): ConfigFileError =>
  new ConfigFileError({
    file,
    stage: "expression",
    expression: Option.some(error.source),
    message: error.message,
  });

const markdownName = (file: InstancePath): Effect.Effect<string, ConfigFileError> => {
  const basename = file.slice(file.lastIndexOf("/") + 1);
  if (!basename.endsWith(".md")) {
    return new ConfigFileError({
      file,
      stage: "schema",
      expression: Option.none(),
      message: "Expected a .md filename",
    });
  }
  return Effect.succeed(basename.slice(0, -3));
};

const loopName = (file: InstancePath): Effect.Effect<LoopName, ConfigFileError> =>
  markdownName(file).pipe(
    Effect.flatMap((name) =>
      Schema.decodeUnknownEffect(LoopFile.fields.name)(name).pipe(
        Effect.mapError((error) => schemaError(file, error)),
      ),
    ),
  );

const agentName = (file: InstancePath): Effect.Effect<AgentName, ConfigFileError> =>
  markdownName(file).pipe(
    Effect.flatMap((name) =>
      Schema.decodeUnknownEffect(AgentName)(name).pipe(
        Effect.mapError((error) => schemaError(file, error)),
      ),
    ),
  );

const interpolations = (
  file: InstancePath,
  body: PromptTemplate,
): Effect.Effect<ReadonlyArray<Interpolation>, ConfigFileError> =>
  Effect.gen(function* () {
    const found: Array<Interpolation> = [];
    let cursor = 0;
    while (cursor < body.length) {
      const start = body.indexOf("{{", cursor);
      if (start < 0) break;
      const end = body.indexOf("}}", start + 2);
      if (end < 0) {
        return yield* new ConfigFileError({
          file,
          stage: "expression",
          expression: Option.none(),
          message: `Unclosed prompt interpolation at character ${start}`,
        });
      }
      const expression = body.slice(start + 2, end).trim();
      const parsed = yield* Schema.decodeUnknownEffect(Source)(expression).pipe(
        Effect.mapError((error) => schemaError(file, error)),
      );
      found.push({ source: parsed, start, end: end + 2 });
      cursor = end + 2;
    }
    return found;
  });

const render = (
  engine: ExpressionEngine["Service"],
  loop: LoopFile,
  context: Schema.JsonObject,
): Effect.Effect<string, ConfigFileError> => {
  const file = loopPath(loop.name);
  const environment = environmentFor(loop.trigger.on);
  return Effect.gen(function* () {
    const expressions = yield* interpolations(file, loop.body);
    const rendered = yield* Effect.forEach(expressions, (expression) =>
      engine.evaluateScalar(expression.source, environment, context).pipe(
        Effect.mapError((error) => expressionError(file, error)),
        Effect.map((value) => ({ expression, value })),
      ),
    );
    let output = "";
    let cursor = 0;
    for (const { expression, value } of rendered) {
      output += loop.body.slice(cursor, expression.start);
      output += String(value);
      cursor = expression.end;
    }
    return output + loop.body.slice(cursor);
  });
};

const parseUsineYaml = Effect.fn("ConfigParser.parseUsineYaml")(
  (file: InstancePath, source: string): Effect.Effect<UsineConfig, ConfigFileError> =>
    Effect.gen(function* () {
      const yaml = yield* parseYaml(file, source);
      return yield* Schema.decodeUnknownEffect(UsineConfig)(yaml, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((error) => schemaError(file, error)));
    }),
);

const parseAgentFile = Effect.fn("ConfigParser.parseAgentFile")(
  (file: InstancePath, source: string): Effect.Effect<AgentFile, ConfigFileError> =>
    Effect.gen(function* () {
      const name = yield* agentName(file);
      const markdown = yield* splitMarkdown(file, source);
      const yaml = yield* parseYaml(file, markdown.yaml);
      const frontmatter = yield* Schema.decodeUnknownEffect(AuthoredAgentFrontmatter)(yaml, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((error) => schemaError(file, error)));
      const persona = yield* Schema.decodeUnknownEffect(AgentPersona)(markdown.body).pipe(
        Effect.mapError((error) => schemaError(file, error)),
      );
      return new AgentFile({
        name,
        harness: frontmatter.harness,
        model: frontmatter.model,
        effort: frontmatter.effort,
        parentModel: frontmatter.parentModel,
        parentEffort: frontmatter.parentEffort,
        persona,
      });
    }),
);

const makeParseLoopFile = (engine: ExpressionEngine["Service"]) =>
  Effect.fn("ConfigParser.parseLoopFile")(
    (file: InstancePath, source: string): Effect.Effect<LoopFile, ConfigFileError> =>
      Effect.gen(function* () {
        const name = yield* loopName(file);
        const markdown = yield* splitMarkdown(file, source);
        const yaml = yield* parseYaml(file, markdown.yaml);
        const frontmatter = yield* Schema.decodeUnknownEffect(AuthoredLoopFrontmatter)(yaml, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError((error) => schemaError(file, error)));
        const body = yield* Schema.decodeUnknownEffect(PromptTemplate)(markdown.body).pipe(
          Effect.mapError((error) => schemaError(file, error)),
        );
        const environment: Environment = environmentFor(frontmatter.trigger.on);
        yield* engine
          .checkBoolean(frontmatter.trigger.if, environment)
          .pipe(Effect.mapError((error) => expressionError(file, error)));
        const promptExpressions = yield* interpolations(file, body);
        yield* Effect.forEach(
          promptExpressions,
          ({ source: expression }) =>
            engine
              .checkScalar(expression, environment)
              .pipe(Effect.mapError((error) => expressionError(file, error))),
          { discard: true },
        );
        return new LoopFile({
          name,
          trigger: frontmatter.trigger,
          selector: frontmatter.selector,
          approval: frontmatter.approval,
          maxCycles: frontmatter.maxCycles,
          permissions: frontmatter.permissions,
          step: frontmatter.step,
          agent: frontmatter.agent,
          body,
        });
      }),
  );

const decodeLabelName = Schema.decodeUnknownOption(GitHubLabelName);

const makeConfigWarnings = (engine: ExpressionEngine["Service"]) =>
  Effect.fn("ConfigParser.configWarnings")(function* (
    config: UsineConfig,
    loops: ReadonlyArray<LoopFile>,
  ) {
    const declared = new Set(config.labels.map(({ name }) => canonicalLabelName(name)));
    const warnings: Array<ConfigWarning> = [];
    for (const repository of config.repos) {
      for (const lane of repository.lanes) {
        for (const source of lane.sources) {
          if ("label" in source && !declared.has(canonicalLabelName(source.label))) {
            warnings.push(
              new UndeclaredLaneLabelWarning({
                repository: repository.name,
                lane: lane.name,
                label: source.label,
              }),
            );
          }
        }
      }
    }
    for (const loop of loops) {
      const literals = yield* engine.relatedStringLiterals(loop.trigger.if, ["item", "labels"]);
      for (const literal of literals) {
        const label = decodeLabelName(literal);
        if (Option.isSome(label) && !declared.has(canonicalLabelName(label.value))) {
          warnings.push(new UndeclaredTriggerLabelWarning({ loop: loop.name, label: label.value }));
        }
      }
    }
    return warnings;
  });

/** The service that parses instance file contents and checks their CEL expressions. */
export class ConfigParser extends Context.Service<
  ConfigParser,
  {
    /** Parses `usine.yaml` contents; `file` is used only in diagnostics. */
    readonly parseUsineYaml: (
      file: InstancePath,
      source: string,
    ) => Effect.Effect<UsineConfig, ConfigFileError>;
    /** Parses an Agent file, taking the Agent name from `file`. */
    readonly parseAgentFile: (
      file: InstancePath,
      source: string,
    ) => Effect.Effect<AgentFile, ConfigFileError>;
    /** Parses a Loop file and checks its `if` and prompt expressions, taking the Loop name from `file`. */
    readonly parseLoopFile: (
      file: InstancePath,
      source: string,
    ) => Effect.Effect<LoopFile, ConfigFileError>;
    /** Returns warnings for undeclared labels used by Board lanes or Loop conditions. */
    readonly configWarnings: (
      config: UsineConfig,
      loops: ReadonlyArray<LoopFile>,
    ) => Effect.Effect<ReadonlyArray<ConfigWarning>, ExpressionCheckError>;
    /** Evaluates the Loop's `{{ ... }}` expressions with `context.item` as the trigger payload and `context.repo` as the repository. */
    readonly renderPrompt: (
      loop: LoopFile,
      context: Schema.JsonObject,
    ) => Effect.Effect<string, ConfigFileError>;
  }
>()("@usine/config/ConfigParser") {
  static readonly layer = Layer.effect(
    ConfigParser,
    Effect.gen(function* () {
      const engine = yield* ExpressionEngine;
      return {
        configWarnings: makeConfigWarnings(engine),
        parseUsineYaml,
        parseAgentFile,
        parseLoopFile: makeParseLoopFile(engine),
        renderPrompt: Effect.fn("ConfigParser.renderPrompt")(
          (loop: LoopFile, context: Schema.JsonObject) => render(engine, loop, context),
        ),
      };
    }),
  );
}

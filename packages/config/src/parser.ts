import { StepName } from "@usine/core/step";
import { ApprovalRequirement, LoopName } from "@usine/core/loop";
import {
  ExpressionEngine,
  type ExpressionCheckError,
  type ExpressionError,
  Source,
} from "@usine/expression/expression-engine";
import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  SchemaGetter,
  SchemaIssue,
  Struct,
} from "effect";
import { splitMarkdown } from "./frontmatter.ts";
import { AgentFile } from "./agent.ts";
import { canonicalLabelName, GitHubLabelName } from "./label.ts";
import { ConfigFileError, ConfigProblem, InstancePath } from "./file.ts";
import {
  type ConfigWarning,
  UndeclaredLaneLabelWarning,
  UndeclaredTriggerLabelWarning,
} from "./instance/diagnostics.ts";
import { LoopFile, loopPath, LoopPriority, PromptTemplate } from "./loop.ts";
import { AgentPersona, AgentName } from "@usine/core/agent";
import { IssueTrigger, PullRequestTrigger, ScheduleTrigger, Stream } from "./trigger.ts";
import { UsineConfig } from "./factory.ts";
import { ValidSelector } from "./selector.ts";
import { Effort, Harness, ModelId } from "@usine/core/agent/brain";
import { environmentFor } from "./payload-slices.ts";
import { parseYamlDocument } from "./yaml/document.ts";
import { writeYaml } from "./yaml/writer.ts";
import { loopReferenceFailure, type ReferenceIndex } from "./instance/references.ts";

const formatIssue = SchemaIssue.makeFormatterDefault();

// YAML reads an unquoted `if: true` as a boolean; it decodes to the same CEL literal.
const ConditionFromYaml = Schema.Union([Schema.String, Schema.Boolean])
  .annotate({
    message: "Expected a CEL expression. Quote the value so that YAML reads it as a string.",
  })
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
  priority: Schema.OptionFromOptionalKey(LoopPriority),
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

export const formatAgent = (agent: AgentFile): string =>
  `---\n${writeYaml(Schema.encodeSync(AuthoredAgentFrontmatter)(new AgentFrontmatter(agent)))}---\n${agent.persona}`;

export const formatLoop = (loop: LoopFile): string =>
  `---\n${writeYaml(Schema.encodeSync(AuthoredLoopFrontmatter)(new LoopFrontmatter(loop)))}---\n${loop.body}`;

interface Interpolation {
  readonly source: Source;
  readonly start: number;
  readonly end: number;
}

const schemaError = (file: InstancePath, error: Schema.SchemaError): ConfigFileError =>
  ConfigFileError.fromSchema(file, error);

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

const expressionError = (
  file: InstancePath,
  error: ExpressionError,
  path: ReadonlyArray<string>,
): ConfigFileError => {
  const detail: typeof ConfigProblem.Type = {
    path,
    message: error.message,
    expression: error.source,
  };
  const positioned =
    error._tag === "ExpressionCheckError" && Option.isSome(error.position)
      ? { ...detail, position: error.position.value }
      : detail;
  return new ConfigFileError({
    file,
    stage: "expression",
    expression: Option.some(error.source),
    message: error.message,
    details: [positioned],
  });
};

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

const interpolations = (file: InstancePath, body: PromptTemplate) => {
  const expressions: Array<Interpolation> = [];
  const problems: Array<ConfigFileError> = [];
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf("{{", cursor);
    if (start < 0) break;
    const end = body.indexOf("}}", start + 2);
    if (end < 0) {
      const message = `The prompt has an unclosed {{ at character ${start}. Close it with }}.`;
      problems.push(
        new ConfigFileError({
          file,
          stage: "expression",
          expression: Option.none(),
          message,
          details: [{ path: ["body"], message }],
        }),
      );
      break;
    }
    const parsed = Schema.decodeUnknownResult(Source)(body.slice(start + 2, end).trim());
    if (Result.isSuccess(parsed)) expressions.push({ source: parsed.success, start, end: end + 2 });
    else {
      const message = `The prompt has an empty expression at character ${start}. Add an expression between {{ and }}.`;
      problems.push(
        new ConfigFileError({
          file,
          stage: "expression",
          expression: Option.none(),
          message,
          details: [{ path: ["body"], message }],
        }),
      );
    }
    cursor = end + 2;
  }
  return { expressions, problems };
};

const expressionFailures = (file: InstancePath, failures: Arr.NonEmptyArray<ConfigFileError>) =>
  new ConfigFileError({
    file,
    stage: "expression",
    expression: failures[0].expression,
    message: failures.map(({ message }) => message).join("\n"),
    details: failures.flatMap(
      (failure) => failure.details ?? [{ path: ["body"], message: failure.message }],
    ),
  });

const render = (
  engine: ExpressionEngine["Service"],
  loop: LoopFile,
  context: Schema.JsonObject,
): Effect.Effect<string, ConfigFileError> => {
  const file = loopPath(loop.name);
  const environment = environmentFor(loop.trigger.on);
  return Effect.gen(function* () {
    const { expressions, problems } = interpolations(file, loop.body);
    if (Arr.isArrayNonEmpty(problems)) return yield* expressionFailures(file, problems);
    const rendered = yield* Effect.forEach(expressions, (expression) =>
      engine.evaluateScalar(expression.source, environment, context).pipe(
        Effect.mapError((error) => expressionError(file, error, ["body"])),
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
        errors: "all",
      }).pipe(Effect.mapError((error) => schemaError(file, error)));
    }),
);

export const parseAgentFile = Effect.fn("ConfigParser.parseAgentFile")(
  (file: InstancePath, source: string): Effect.Effect<AgentFile, ConfigFileError> =>
    Effect.gen(function* () {
      const name = yield* agentName(file);
      const markdown = yield* splitMarkdown(file, source);
      const yaml = yield* parseYaml(file, markdown.yaml);
      const frontmatter = yield* Schema.decodeUnknownEffect(AuthoredAgentFrontmatter)(yaml, {
        onExcessProperty: "error",
        errors: "all",
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

/** Parses the export format without checking expressions, for form drafts. */
export const parseLoopDraft = (file: InstancePath, source: string) =>
  Effect.gen(function* () {
    const name = yield* loopName(file);
    const markdown = yield* splitMarkdown(file, source);
    const yaml = yield* parseYaml(file, markdown.yaml);
    const frontmatter = yield* Schema.decodeUnknownEffect(AuthoredLoopFrontmatter)(yaml, {
      onExcessProperty: "error",
      errors: "all",
    }).pipe(Effect.mapError((error) => schemaError(file, error)));
    const body = yield* Schema.decodeUnknownEffect(PromptTemplate)(markdown.body).pipe(
      Effect.mapError((error) => {
        const failure = schemaError(file, error);
        return new ConfigFileError({
          ...failure,
          message: failure.message,
          details: [{ path: ["body"], message: failure.message }],
        });
      }),
    );
    return new LoopFile({ name, ...frontmatter, body });
  });

const checkExpressions = (
  engine: ExpressionEngine["Service"],
  file: InstancePath,
  stream: Option.Option<Stream>,
  condition: Option.Option<Source>,
  body: Option.Option<PromptTemplate>,
) =>
  Effect.gen(function* () {
    const failures: Array<ConfigFileError> = [];
    const prompt = Option.isNone(body)
      ? { expressions: [], problems: [] }
      : interpolations(file, body.value);
    failures.push(...prompt.problems);
    if (Option.isNone(stream)) return failures;
    const environment = environmentFor(stream.value);
    if (Option.isSome(condition)) {
      const checked = yield* engine.checkBoolean(condition.value, environment).pipe(Effect.result);
      if (Result.isFailure(checked))
        failures.push(expressionError(file, checked.failure, ["trigger", "if"]));
    }
    for (const { source } of prompt.expressions) {
      const checked = yield* engine.checkScalar(source, environment).pipe(Effect.result);
      if (Result.isFailure(checked))
        failures.push(expressionError(file, checked.failure, ["body"]));
    }
    return failures;
  });

const LoopJson = Schema.toCodecJson(LoopFile);
const LoopText = Schema.Struct({
  frontmatter: AuthoredLoopFrontmatter,
  name: LoopFile.fields.name,
  body: PromptTemplate,
});

const makeCheckLoopDraft = (engine: ExpressionEngine["Service"]) =>
  Effect.fn("ConfigParser.checkLoopDraft")(function* (
    file: InstancePath,
    input: { readonly text: string } | { readonly value: Schema.Json },
    references: Option.Option<ReferenceIndex>,
  ) {
    yield* Effect.annotateCurrentSpan({ file });
    const authored = "text" in input;
    const { value, parsed } = yield* authored
      ? Effect.gen(function* () {
          const markdown = yield* splitMarkdown(file, input.text);
          const yaml = yield* parseYaml(file, markdown.yaml);
          const fields = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(yaml).pipe(
            Effect.mapError((error) => schemaError(file, error)),
          );
          const parsed = Schema.decodeUnknownResult(LoopText)(
            {
              frontmatter: fields,
              name: yield* markdownName(file),
              body: markdown.body,
            },
            { errors: "all", onExcessProperty: "error" },
          ).pipe(
            Result.map(({ frontmatter, ...rest }) => new LoopFile({ ...frontmatter, ...rest })),
            Result.mapError((error) => {
              const failure = schemaError(file, error);
              return new ConfigFileError({
                ...failure,
                message: failure.message,
                details: (failure.details ?? []).map((detail) => ({
                  ...detail,
                  path: detail.path[0] === "frontmatter" ? detail.path.slice(1) : detail.path,
                })),
              });
            }),
          );
          return { value: { ...fields, body: markdown.body }, parsed };
        })
      : Effect.succeed({
          value: input.value,
          parsed: Schema.decodeUnknownResult(LoopJson)(input.value, {
            errors: "all",
            onExcessProperty: "error",
          }).pipe(Result.mapError((error) => schemaError(file, error))),
        });
    const problems: Array<ConfigFileError> = Result.isFailure(parsed) ? [parsed.failure] : [];
    if (!authored) {
      const named = Schema.decodeUnknownOption(Schema.Struct({ name: LoopFile.fields.name }))(
        value,
      );
      if (Option.isSome(named) && named.value.name !== (yield* markdownName(file))) {
        const message = "Entity identifier does not match its name";
        problems.push(
          new ConfigFileError({
            file,
            stage: "schema",
            expression: Option.none(),
            message,
            details: [{ path: ["name"], message }],
          }),
        );
      }
    }
    const stream = Schema.decodeUnknownOption(
      Schema.Struct({ trigger: Schema.Struct({ on: Stream }) }),
    )(value);
    const condition = Schema.decodeUnknownOption(
      Schema.Struct({ trigger: Schema.Struct({ if: authored ? ConditionFromYaml : Source }) }),
    )(value);
    const body = Schema.decodeUnknownOption(Schema.Struct({ body: PromptTemplate }))(value);
    problems.push(
      ...(yield* checkExpressions(
        engine,
        file,
        Option.map(stream, ({ trigger }) => trigger.on),
        Option.map(condition, ({ trigger }) => trigger.if),
        Option.map(body, ({ body }) => body),
      )),
    );
    const agent = Schema.decodeUnknownOption(Schema.Struct({ agent: AgentName }))(value);
    const selector = Schema.decodeUnknownOption(
      Schema.Struct({
        selector: authored
          ? LoopFrontmatter.fields.selector
          : Schema.toCodecJson(LoopFile.fields.selector),
      }),
    )(value);
    const reference = Option.flatMap(references, (index) =>
      loopReferenceFailure(
        file,
        {
          agent: Option.getOrUndefined(Option.map(agent, ({ agent }) => agent)),
          selector: Option.flatMap(selector, ({ selector }) => selector),
        },
        index,
      ),
    );
    if (Option.isSome(reference)) problems.push(reference.value);
    yield* Effect.logDebug("Checked independent loop fields", { file, problems: problems.length });
    return {
      loop: Result.isSuccess(parsed) ? Option.some(parsed.success) : Option.none<LoopFile>(),
      problems,
    };
  });

const makeParseLoopFile = (engine: ExpressionEngine["Service"]) =>
  Effect.fn("ConfigParser.parseLoopFile")(
    (file: InstancePath, source: string): Effect.Effect<LoopFile, ConfigFileError> =>
      Effect.gen(function* () {
        const loop = yield* parseLoopDraft(file, source);
        const failures = yield* checkExpressions(
          engine,
          file,
          Option.some(loop.trigger.on),
          Option.some(loop.trigger.if),
          Option.some(loop.body),
        );
        if (Arr.isArrayNonEmpty(failures)) return yield* expressionFailures(file, failures);
        return loop;
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
    /** Collects schema, expression, template, and reference problems from usable draft fields. */
    readonly checkLoopDraft: (
      file: InstancePath,
      input: { readonly text: string } | { readonly value: Schema.Json },
      references: Option.Option<ReferenceIndex>,
    ) => Effect.Effect<
      { readonly loop: Option.Option<LoopFile>; readonly problems: ReadonlyArray<ConfigFileError> },
      ConfigFileError
    >;
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
      return makeConfigParser(engine);
    }),
  );
}

/** Builds the parser from an explicit expression engine without a layer. */
export const makeConfigParser = (engine: ExpressionEngine["Service"]): ConfigParser["Service"] => ({
  configWarnings: makeConfigWarnings(engine),
  checkLoopDraft: makeCheckLoopDraft(engine),
  parseUsineYaml,
  parseAgentFile,
  parseLoopFile: makeParseLoopFile(engine),
  renderPrompt: Effect.fn("ConfigParser.renderPrompt")(
    (loop: LoopFile, context: Schema.JsonObject) => render(engine, loop, context),
  ),
});

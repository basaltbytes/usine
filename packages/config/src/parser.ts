import { Step } from "@usine/core";
import {
  type CheckError,
  type Environment,
  type EvaluationError,
  ExpressionEngine,
  Source,
} from "@usine/expression";
import { Context, Effect, Layer, Option, Schema, SchemaIssue } from "effect";
import { parseDocument } from "yaml";
import { ConfigFileError } from "./errors.ts";
import { splitMarkdown } from "./frontmatter.ts";
import {
  AgentFile,
  AgentName,
  Approval,
  Effort,
  Harness,
  LoopFile,
  LoopName,
  ModelId,
  Persona,
  PromptTemplate,
  Trigger,
  UsineConfig,
  ValidSelector,
} from "./model.ts";
import { environmentFor } from "./payload-slices.ts";

const formatIssue = SchemaIssue.makeFormatterDefault();

class LoopFrontmatter extends Schema.Class<LoopFrontmatter>("Config/LoopFrontmatter")({
  trigger: Trigger,
  selector: Schema.OptionFromOptionalKey(ValidSelector),
  approval: Approval.pipe(Schema.withDecodingDefaultKey(Effect.succeed("none"))),
  step: Step.StepName.pipe(Schema.withDecodingDefaultKey(Effect.succeed("run"))),
  agent: AgentName,
}) {}

class AgentFrontmatter extends Schema.Class<AgentFrontmatter>("Config/AgentFrontmatter")({
  harness: Harness,
  model: ModelId,
  effort: Effort,
  parent_model: Schema.OptionFromOptionalKey(ModelId),
}) {}

interface Interpolation {
  readonly source: Source;
  readonly start: number;
  readonly end: number;
}

const causeMessage = (cause: unknown): string =>
  Option.match(
    Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }))(cause),
    {
      onNone: () => "Unknown YAML parsing failure",
      onSome: ({ message }) => message,
    },
  );

const schemaError = (file: string, error: Schema.SchemaError): ConfigFileError =>
  new ConfigFileError({ file, stage: "schema", message: formatIssue(error.issue) });

const parseYaml = (file: string, source: string): Effect.Effect<Schema.Json, ConfigFileError> =>
  Effect.gen(function* () {
    const document = yield* Effect.try({
      try: () =>
        parseDocument(source, {
          prettyErrors: true,
          strict: true,
          uniqueKeys: true,
        }),
      catch: (cause) => new ConfigFileError({ file, stage: "yaml", message: causeMessage(cause) }),
    });
    const syntaxIssue = document.errors[0] ?? document.warnings[0];
    if (syntaxIssue !== undefined) {
      return yield* new ConfigFileError({
        file,
        stage: "yaml",
        message: syntaxIssue.message,
      });
    }
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.Json)(document.toJS()),
      catch: (cause) => new ConfigFileError({ file, stage: "yaml", message: causeMessage(cause) }),
    });
  });

const expressionError = (file: string, error: CheckError | EvaluationError): ConfigFileError =>
  new ConfigFileError({ file, stage: "expression", message: error.message });

const markdownName = (file: string): Effect.Effect<string, ConfigFileError> => {
  const basename = file.slice(file.lastIndexOf("/") + 1);
  if (!basename.endsWith(".md")) {
    return new ConfigFileError({
      file,
      stage: "schema",
      message: "Expected a .md filename",
    });
  }
  return Effect.succeed(basename.slice(0, -3));
};

const loopName = (file: string): Effect.Effect<LoopName, ConfigFileError> =>
  markdownName(file).pipe(
    Effect.flatMap((name) =>
      Schema.decodeUnknownEffect(LoopName)(name).pipe(
        Effect.mapError((error) => schemaError(file, error)),
      ),
    ),
  );

const agentName = (file: string): Effect.Effect<AgentName, ConfigFileError> =>
  markdownName(file).pipe(
    Effect.flatMap((name) =>
      Schema.decodeUnknownEffect(AgentName)(name).pipe(
        Effect.mapError((error) => schemaError(file, error)),
      ),
    ),
  );

const interpolations = (
  file: string,
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
  const file = `loops/${loop.name}.md`;
  const environment = environmentFor(loop.trigger.on);
  return Effect.gen(function* () {
    const expressions = yield* interpolations(file, loop.body);
    const rendered = yield* Effect.forEach(
      expressions,
      (expression) =>
        engine.evaluateScalar(expression.source, environment, context).pipe(
          Effect.mapError((error) => expressionError(file, error)),
          Effect.map((value) => ({ expression, value })),
        ),
      { concurrency: 16 },
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
  (file: string, source: string): Effect.Effect<UsineConfig, ConfigFileError> =>
    Effect.gen(function* () {
      const yaml = yield* parseYaml(file, source);
      return yield* Schema.decodeUnknownEffect(UsineConfig)(yaml, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((error) => schemaError(file, error)));
    }),
);

const parseAgentFile = Effect.fn("ConfigParser.parseAgentFile")(
  (file: string, source: string): Effect.Effect<AgentFile, ConfigFileError> =>
    Effect.gen(function* () {
      const name = yield* agentName(file);
      const markdown = yield* splitMarkdown(file, source);
      const yaml = yield* parseYaml(file, markdown.yaml);
      const frontmatter = yield* Schema.decodeUnknownEffect(AgentFrontmatter)(yaml, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError((error) => schemaError(file, error)));
      const persona = yield* Schema.decodeUnknownEffect(Persona)(markdown.body).pipe(
        Effect.mapError((error) => schemaError(file, error)),
      );
      return new AgentFile({
        name,
        harness: frontmatter.harness,
        model: frontmatter.model,
        effort: frontmatter.effort,
        parentModel: frontmatter.parent_model,
        persona,
      });
    }),
);

const makeParseLoopFile = (engine: ExpressionEngine["Service"]) =>
  Effect.fn("ConfigParser.parseLoopFile")(
    (file: string, source: string): Effect.Effect<LoopFile, ConfigFileError> =>
      Effect.gen(function* () {
        const name = yield* loopName(file);
        const markdown = yield* splitMarkdown(file, source);
        const yaml = yield* parseYaml(file, markdown.yaml);
        const frontmatter = yield* Schema.decodeUnknownEffect(LoopFrontmatter)(yaml, {
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
          { concurrency: 16, discard: true },
        );
        return new LoopFile({
          name,
          trigger: frontmatter.trigger,
          selector: frontmatter.selector,
          approval: frontmatter.approval,
          step: frontmatter.step,
          agent: frontmatter.agent,
          body,
        });
      }),
  );

/** Strict config parser and prompt renderer. All methods capture their CEL dependency. */
export class ConfigParser extends Context.Service<
  ConfigParser,
  {
    readonly parseUsineYaml: typeof parseUsineYaml;
    readonly parseAgentFile: typeof parseAgentFile;
    readonly parseLoopFile: ReturnType<typeof makeParseLoopFile>;
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

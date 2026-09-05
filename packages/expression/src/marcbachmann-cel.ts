import {
  type ASTNode,
  Environment as CelEnvironment,
  ParseError as CelParseError,
  TypeError as CelTypeError,
  parse,
} from "@marcbachmann/cel-js";
import { Effect, Layer, Option, Schema } from "effect";
import { ExpressionEngine } from "./expression-engine.ts";
import {
  type Environment,
  ExpressionCheckError,
  ExpressionEvaluationError,
  type ObjectType,
  Scalar,
  type Source,
  TypeReference,
} from "./model.ts";

const decodeTypeReference = Schema.decodeUnknownSync(TypeReference);

type VendorCheckError = CelParseError | CelTypeError;

type RuntimeValue =
  | null
  | string
  | number
  | bigint
  | boolean
  | ReadonlyArray<RuntimeValue>
  | RuntimeObject;

interface RuntimeObject {
  readonly [key: string]: RuntimeValue;
}

const acceptedScalarTypes: ReadonlySet<string> = new Set([
  "bool",
  "double",
  "int",
  "null_type",
  "string",
  "uint",
]);

const messageFromCause = (cause: unknown, fallback: string): string =>
  Option.match(
    Schema.decodeUnknownOption(Schema.Struct({ message: Schema.NonEmptyString }))(cause),
    {
      onNone: () => fallback,
      onSome: ({ message }) => message,
    },
  );

const checkFailure = (source: Source, error: VendorCheckError | undefined): ExpressionCheckError =>
  error === undefined
    ? new ExpressionCheckError({
        source,
        code: "check_failed",
        message: "CEL check failed without an error detail",
        position: Option.none(),
      })
    : new ExpressionCheckError({
        source,
        code: error instanceof CelParseError ? "parse_error" : "type_error",
        message: error.message,
        position: Option.fromNullishOr(error.range?.start),
      });

const childNodes = (node: ASTNode): ReadonlyArray<ASTNode> => {
  switch (node.op) {
    case "value":
    case "id":
      return [];
    case ".":
    case ".?":
      return [node.args[0]];
    case "!_":
    case "-_":
      return [node.args];
    case "call":
      return node.args[1];
    case "rcall":
      return [node.args[1], ...node.args[2]];
    case "list":
      return node.args;
    case "map":
      return node.args.flatMap(([key, value]) => [key, value]);
    default:
      return node.args;
  }
};

type MemberPath = readonly [string, ...Array<string>];

const pathOf = (node: ASTNode): MemberPath | undefined => {
  if (node.op === "id") return [node.args];
  if (node.op !== "." && node.op !== ".?") return undefined;
  const parent = pathOf(node.args[0]);
  return parent === undefined ? undefined : [...parent, node.args[1]];
};

const decodeStringLiteral = Schema.decodeUnknownOption(Schema.String);

const MACROS_WITH_BINDINGS: ReadonlySet<string> = new Set([
  "all",
  "exists",
  "exists_one",
  "filter",
  "map",
]);

type MacroBindings = ReadonlyMap<string, ReadonlyArray<string>>;

/** The member path a node reads from, followed back through macro bindings and collection transformations. */
const lineagePathOf = (
  node: ASTNode,
  bindings: MacroBindings,
): ReadonlyArray<string> | undefined => {
  const path = pathOf(node);
  if (path !== undefined) {
    const boundPath = bindings.get(path[0]);
    return boundPath === undefined ? path : [...boundPath, ...path.slice(1)];
  }
  if (node.op !== "rcall") return undefined;

  const [macro, receiver, args] = node.args;
  const receiverPath = lineagePathOf(receiver, bindings);
  if (receiverPath === undefined) return undefined;
  if (macro === "filter") return receiverPath;
  if (macro !== "map") return undefined;

  const [binding, ...body] = args;
  const projection = body[body.length - 1];
  if (binding?.op !== "id" || projection === undefined) return undefined;
  return lineagePathOf(projection, new Map(bindings).set(binding.args, receiverPath));
};

const startsWithPath = (path: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean =>
  prefix.every((part, index) => path[index] === part);

/**
 * The string literals an operand can evaluate to. Only result positions count:
 * a conditional contributes its branches and not its test, a list its
 * elements. `item.state == "OPEN" ? "ready" : "review"` yields the two labels
 * and not the state.
 */
const resultStringLiterals = (node: ASTNode): ReadonlyArray<string> => {
  switch (node.op) {
    case "value":
      return Option.match(decodeStringLiteral(node.args), {
        onNone: () => [],
        onSome: (literal) => [literal],
      });
    case "?:": {
      const [, whenTrue, whenFalse] = node.args;
      return [...resultStringLiterals(whenTrue), ...resultStringLiterals(whenFalse)];
    }
    case "list":
      return node.args.flatMap(resultStringLiterals);
    default:
      return [];
  }
};

const isRelatedName = (
  node: ASTNode,
  memberPath: ReadonlyArray<string>,
  bindings: MacroBindings,
): boolean => {
  const path = lineagePathOf(node, bindings);
  return path !== undefined && startsWithPath(path, memberPath) && path[path.length - 1] === "name";
};

const comparisonLiterals = (
  node: ASTNode,
  memberPath: ReadonlyArray<string>,
  bindings: MacroBindings,
): ReadonlyArray<string> => {
  switch (node.op) {
    case "!=":
    case "==":
    case "in": {
      const [left, right] = node.args;
      return [
        ...(isRelatedName(left, memberPath, bindings) ? resultStringLiterals(right) : []),
        ...(isRelatedName(right, memberPath, bindings) ? resultStringLiterals(left) : []),
      ];
    }
    default:
      return [];
  }
};

/** Collects the literals compared against `name` on members bound by macros over the watched collection. */
const scanRelatedLiterals = (
  node: ASTNode,
  memberPath: ReadonlyArray<string>,
  bindings: MacroBindings,
): ReadonlyArray<string> => {
  const related = comparisonLiterals(node, memberPath, bindings);
  if (node.op !== "rcall" || !MACROS_WITH_BINDINGS.has(node.args[0])) {
    return [
      ...related,
      ...childNodes(node).flatMap((child) => scanRelatedLiterals(child, memberPath, bindings)),
    ];
  }

  const [, receiver, args] = node.args;
  const [binding, ...body] = args;
  const receiverPath = lineagePathOf(receiver, bindings);
  if (binding?.op !== "id" || receiverPath === undefined) {
    return [
      ...related,
      ...childNodes(node).flatMap((child) => scanRelatedLiterals(child, memberPath, bindings)),
    ];
  }

  const bodyBindings = new Map(bindings).set(binding.args, receiverPath);
  return [
    ...related,
    ...scanRelatedLiterals(receiver, memberPath, bindings),
    ...body.flatMap((child) => scanRelatedLiterals(child, memberPath, bodyBindings)),
  ];
};

const relatedStringLiterals = Effect.fn("ExpressionEngine.relatedStringLiterals")(function* (
  source: Source,
  memberPath: ReadonlyArray<string>,
) {
  if (memberPath.length === 0) return [];
  const ast = yield* Effect.try({
    try: () => parse(source).ast,
    catch: (cause) =>
      cause instanceof CelParseError
        ? checkFailure(source, cause)
        : new ExpressionCheckError({
            source,
            code: "check_failed",
            message: messageFromCause(cause, "CEL analysis failed"),
            position: Option.none(),
          }),
  });
  return [...new Set(scanRelatedLiterals(ast, memberPath, new Map()))];
});

const makeEnvironment = (descriptor: Environment): CelEnvironment => {
  const environment = new CelEnvironment({ unlistedVariablesAreDyn: false });
  for (const objectType of descriptor.types) {
    environment.registerType(objectType.name, {
      fields: Object.fromEntries(objectType.fields.map((field) => [field.name, field.type])),
    });
  }
  for (const variable of descriptor.variables) {
    environment.registerVariable(variable.name, variable.type);
  }
  return environment;
};

const normalizeValue = (
  value: Schema.Json,
  type: TypeReference,
  objectTypes: ReadonlyMap<string, ObjectType>,
): RuntimeValue => {
  if (
    (type === "int" || type === "uint") &&
    Schema.is(Schema.Number)(value) &&
    Number.isInteger(value)
  ) {
    return BigInt(value);
  }
  if (type.startsWith("list<") && type.endsWith(">") && Array.isArray(value)) {
    const itemType = decodeTypeReference(type.slice(5, -1));
    return value.map((item) => normalizeValue(item, itemType, objectTypes));
  }
  const objectType = objectTypes.get(type);
  if (objectType !== undefined && Schema.is(Schema.JsonObject)(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, fieldValue]) => {
        const field = objectType.fields.find(({ name }) => name === key);
        return [
          key,
          field === undefined ? fieldValue : normalizeValue(fieldValue, field.type, objectTypes),
        ];
      }),
    );
  }
  return value;
};

const normalizeContext = (context: Schema.JsonObject, descriptor: Environment): RuntimeObject => {
  const objectTypes = new Map(descriptor.types.map((type) => [type.name, type]));
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => {
      const variable = descriptor.variables.find(({ name }) => name === key);
      return [
        key,
        variable === undefined ? value : normalizeValue(value, variable.type, objectTypes),
      ];
    }),
  );
};

const checkExpected = (
  source: Source,
  environment: Environment,
  accepts: (resultType: string) => boolean,
  expected: string,
): Effect.Effect<void, ExpressionCheckError> =>
  Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () => makeEnvironment(environment).check(source),
      catch: (cause) =>
        new ExpressionCheckError({
          source,
          code: "check_failed",
          message: messageFromCause(cause, "CEL check failed"),
          position: Option.none(),
        }),
    });
    if (!result.valid) return yield* checkFailure(source, result.error);
    const resultType = result.type;
    if (resultType === undefined || !accepts(resultType)) {
      return yield* new ExpressionCheckError({
        source,
        code: "unexpected_result_type",
        message: `Expected ${expected}, got ${resultType ?? "an unknown type"}`,
        position: Option.none(),
      });
    }
  });

const evaluateRaw = (
  source: Source,
  environment: Environment,
  context: Schema.JsonObject,
): Effect.Effect<RuntimeValue, ExpressionEvaluationError> =>
  Effect.try({
    try: () =>
      // SAFETY: CEL evaluates to the same value vocabulary the context is built
      // from, and every caller decodes the expected result type before use.
      makeEnvironment(environment).evaluate(
        source,
        normalizeContext(context, environment),
      ) as RuntimeValue,
    catch: (cause) =>
      new ExpressionEvaluationError({
        source,
        message: messageFromCause(cause, "CEL evaluation failed"),
      }),
  });

const unexpectedResult = (source: Source, expected: string) => () =>
  new ExpressionEvaluationError({
    source,
    message: `CEL evaluation returned a value that is not ${expected}`,
  });

const checkBoolean = Effect.fn("ExpressionEngine.checkBoolean")(
  (source: Source, environment: Environment): Effect.Effect<void, ExpressionCheckError> =>
    checkExpected(source, environment, (resultType) => resultType === "bool", "bool"),
);

const checkScalar = Effect.fn("ExpressionEngine.checkScalar")(
  (source: Source, environment: Environment): Effect.Effect<void, ExpressionCheckError> =>
    checkExpected(
      source,
      environment,
      (resultType) => acceptedScalarTypes.has(resultType),
      "a scalar value",
    ),
);

const decodeBoolean = Schema.decodeUnknownEffect(Schema.Boolean);
const decodeScalar = Schema.decodeUnknownEffect(Scalar);

const evaluateBoolean = Effect.fn("ExpressionEngine.evaluateBoolean")(function* (
  source: Source,
  environment: Environment,
  context: Schema.JsonObject,
) {
  yield* checkBoolean(source, environment);
  const value = yield* evaluateRaw(source, environment, context);
  return yield* decodeBoolean(value).pipe(Effect.mapError(unexpectedResult(source, "a boolean")));
});

const evaluateScalar = Effect.fn("ExpressionEngine.evaluateScalar")(function* (
  source: Source,
  environment: Environment,
  context: Schema.JsonObject,
) {
  yield* checkScalar(source, environment);
  const value = yield* evaluateRaw(source, environment, context);
  return yield* decodeScalar(value).pipe(
    Effect.mapError(unexpectedResult(source, "a scalar value")),
  );
});

/** The ExpressionEngine implementation on @marcbachmann/cel-js. */
export const MarcbachmannCelLayer = Layer.succeed(ExpressionEngine, {
  relatedStringLiterals,
  checkBoolean,
  checkScalar,
  evaluateBoolean,
  evaluateScalar,
});

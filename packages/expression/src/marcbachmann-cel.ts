import {
  type ASTNode,
  Environment as CelEnvironment,
  type EnvironmentOptions,
  ParseError as CelParseError,
  type ParseResult,
  TypeError as CelTypeError,
  type TypeCheckResult,
} from "@marcbachmann/cel-js";
import { Effect, Layer, Option, Predicate, Result, Schema } from "effect";
import { type Environment, TypeReference } from "./environment.ts";
import {
  ExpressionEngine,
  ExpressionCheckError,
  ExpressionEvaluationError,
  Scalar,
  type Source,
} from "./expression-engine.ts";

const decodeTypeReference = Schema.decodeUnknownSync(TypeReference);

const ENVIRONMENT_OPTIONS = {
  unlistedVariablesAreDyn: false,
  enableOptionalTypes: true,
} as const satisfies EnvironmentOptions;

/** Parser for {@link relatedStringLiterals}, with the checking options so that it accepts `.?`. */
const parser = new CelEnvironment(ENVIRONMENT_OPTIONS);

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
  "null",
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
        message: "The CEL check failed and returned no error details",
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

/** Returns the member path that a node reads, resolved through macro bindings and `filter`/`map` receivers, or `undefined`. */
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

/** Returns the string literals an operand can evaluate to: a literal, both branches of `?:`, and list elements. */
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

/** Returns the literals compared with `name` on values under `memberPath`, including through macro variables. */
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
    try: () => parser.parse(source).ast,
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

type EnvironmentPurpose = "check" | "evaluate";

/**
 * Creates the cel-js environment for checking or evaluating `descriptor`. Because cel-js rejects
 * `null` in a typed field and can't index `dyn<T>`, evaluation declares nullable fields as `dyn`.
 * Map values use `dyn` during evaluation because cel-js does not convert JSON map values to
 * registered object types. Both environments register `T == null`.
 */
const makeEnvironment = (descriptor: Environment, purpose: EnvironmentPurpose): CelEnvironment => {
  const environment = new CelEnvironment(ENVIRONMENT_OPTIONS);
  const nullableTypes = new Set<TypeReference>();
  const runtimeType = (type: TypeReference) =>
    purpose === "evaluate" && type.startsWith("map<")
      ? `${type.slice(0, type.indexOf(",") + 1)}dyn>`
      : type;
  for (const objectType of descriptor.types) {
    environment.registerType(objectType.name, {
      fields: Object.fromEntries(
        objectType.fields.map((field) => {
          if (!field.nullable) return [field.name, runtimeType(field.type)];
          nullableTypes.add(field.type);
          return [field.name, purpose === "check" ? field.type : "dyn"];
        }),
      ),
    });
  }
  for (const type of nullableTypes) {
    environment.registerOperator(
      `${type} == null`,
      (left: RuntimeValue, right: null) => left === right,
    );
  }
  for (const variable of descriptor.variables) {
    environment.registerVariable(variable.name, runtimeType(variable.type));
  }
  return environment;
};

/** Returns whether `value` is a JSON object, checking only the top level because the context is already `Schema.Json` (#464). */
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

type Normalize = (value: Schema.Json) => RuntimeValue;

/** The identity normalizer, compared by reference to skip types that need no normalization. */
const unchanged: Normalize = (value) => value;

interface NormalizedObject {
  [key: string]: RuntimeValue;
}

/** Sets `name` as an own property, including `__proto__`. */
const setField = (target: NormalizedObject, name: string, value: RuntimeValue) => {
  if (name === "__proto__") {
    Object.defineProperty(target, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    target[name] = value;
  }
};

/**
 * Returns the context normalizer for `descriptor`, which converts `int` and `uint` numbers to
 * `bigint` and sets absent nullable fields to `null`, recursing into list items, map values, and declared
 * object fields. Returns unchanged values as is, and shallow-copies changed objects.
 */
const contextNormalizer = (
  descriptor: Environment,
): ((context: Schema.JsonObject) => RuntimeObject) => {
  const objectTypes = new Map(descriptor.types.map((type) => [type.name, type]));
  const compiled = new Map<TypeReference, Normalize>();
  // Can't recurse forever: the Environment declares each type before any type that references it.
  const normalizerOf = (type: TypeReference): Normalize => {
    const existing = compiled.get(type);
    if (existing !== undefined) return existing;
    const normalize = compile(type);
    compiled.set(type, normalize);
    return normalize;
  };
  const compile = (type: TypeReference): Normalize => {
    if (type === "int" || type === "uint") {
      return (value) =>
        Predicate.isNumber(value) && Number.isInteger(value) ? BigInt(value) : value;
    }
    if (type.startsWith("list<") && type.endsWith(">")) {
      const normalizeItem = normalizerOf(decodeTypeReference(type.slice(5, -1)));
      if (normalizeItem === unchanged) return unchanged;
      return (value) => (Array.isArray(value) ? value.map(normalizeItem) : value);
    }
    if (type.startsWith("map<") && type.endsWith(">")) {
      const normalizeValue = normalizerOf(
        decodeTypeReference(type.slice(type.indexOf(",") + 1, -1)),
      );
      if (normalizeValue === unchanged) return unchanged;
      return (value) =>
        isJsonObject(value)
          ? Object.fromEntries(
              Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]),
            )
          : value;
    }
    const objectType = objectTypes.get(type);
    if (objectType === undefined) return unchanged;
    const fields = objectType.fields.flatMap(({ name, type: fieldType }) => {
      const normalize = normalizerOf(fieldType);
      return normalize === unchanged ? [] : [[name, normalize] as const];
    });
    const nullable = objectType.fields.filter((field) => field.nullable).map(({ name }) => name);
    if (fields.length === 0 && nullable.length === 0) return unchanged;
    return (value) => {
      if (!isJsonObject(value)) return value;
      const normalized: NormalizedObject = { ...value };
      for (const [name, normalize] of fields) {
        const fieldValue = value[name];
        if (fieldValue !== undefined && Object.hasOwn(value, name)) {
          setField(normalized, name, normalize(fieldValue));
        }
      }
      for (const name of nullable) {
        if (!Object.hasOwn(value, name)) setField(normalized, name, null);
      }
      return normalized;
    };
  };
  const variables = new Map(
    descriptor.variables.map((variable) => [variable.name, normalizerOf(variable.type)]),
  );
  return (context) => {
    const normalized: NormalizedObject = { ...context };
    for (const [name, normalize] of variables) {
      const value = context[name];
      if (value !== undefined && Object.hasOwn(context, name)) {
        setField(normalized, name, normalize(value));
      }
    }
    return normalized;
  };
};

/** The maximum number of cached check results, and of parse results, per environment. */
const KEPT_EXPRESSIONS = 256;

/** Stores `value` under `key` and returns it, evicting the oldest entry if the map is full. */
const keep = <A>(kept: Map<Source, A>, key: Source, value: A): A => {
  if (kept.size >= KEPT_EXPRESSIONS) {
    const oldest = kept.keys().next();
    if (oldest.done !== true) kept.delete(oldest.value);
  }
  kept.set(key, value);
  return value;
};

/** The per-descriptor cache of cel-js environments and check and parse results. */
interface DescriptorRuntime {
  readonly normalize: (context: Schema.JsonObject) => RuntimeObject;
  check: Option.Option<CelEnvironment>;
  evaluate: Option.Option<CelEnvironment>;
  readonly checked: Map<Source, TypeCheckResult>;
  readonly parsed: Map<Source, ParseResult>;
}

/** Functions that check and evaluate expressions; both rethrow cel-js errors. */
interface CelRuntimes {
  readonly check: (descriptor: Environment, source: Source) => TypeCheckResult;
  readonly evaluate: (
    descriptor: Environment,
    source: Source,
    context: Schema.JsonObject,
  ) => RuntimeValue;
}

/**
 * Creates a cache of cel-js environments, check results, and parse results, keyed by descriptor
 * in a `WeakMap` (#464). Doesn't cache a build or parse that throws, and keeps the
 * {@link KEPT_EXPRESSIONS} newest entries per cache. A cached parse result retains the last
 * evaluated context until the next evaluation.
 */
const celRuntimes = (): CelRuntimes => {
  const runtimes = new WeakMap<Environment, DescriptorRuntime>();
  const runtimeOf = (descriptor: Environment): DescriptorRuntime => {
    const existing = runtimes.get(descriptor);
    if (existing !== undefined) return existing;
    const runtime: DescriptorRuntime = {
      normalize: contextNormalizer(descriptor),
      check: Option.none(),
      evaluate: Option.none(),
      checked: new Map(),
      parsed: new Map(),
    };
    runtimes.set(descriptor, runtime);
    return runtime;
  };
  const environmentOf = (
    runtime: DescriptorRuntime,
    descriptor: Environment,
    purpose: EnvironmentPurpose,
  ): CelEnvironment =>
    Option.getOrElse(runtime[purpose], () => {
      const environment = makeEnvironment(descriptor, purpose);
      runtime[purpose] = Option.some(environment);
      return environment;
    });
  return {
    check: (descriptor, source) => {
      const runtime = runtimeOf(descriptor);
      return (
        runtime.checked.get(source) ??
        keep(runtime.checked, source, environmentOf(runtime, descriptor, "check").check(source))
      );
    },
    evaluate: (descriptor, source, context) => {
      const runtime = runtimeOf(descriptor);
      const parsed =
        runtime.parsed.get(source) ??
        keep(runtime.parsed, source, environmentOf(runtime, descriptor, "evaluate").parse(source));
      // SAFETY: CEL returns values of the context's types, and callers decode the result type.
      return parsed(runtime.normalize(context)) as RuntimeValue;
    },
  };
};

const checkExpected = (
  runtimes: CelRuntimes,
  source: Source,
  environment: Environment,
  accepts: (resultType: string) => boolean,
  expected: string,
): Effect.Effect<void, ExpressionCheckError> =>
  Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () => runtimes.check(environment, source),
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

const evaluated = (
  runtimes: CelRuntimes,
  source: Source,
  environment: Environment,
  context: Schema.JsonObject,
): Result.Result<RuntimeValue, ExpressionEvaluationError> =>
  Result.try({
    try: () => runtimes.evaluate(environment, source, context),
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

const isBooleanType = (resultType: string): boolean => resultType === "bool";
const decodeScalar = Schema.decodeUnknownEffect(Scalar);

export const makeExpressionEngine = () => {
  const runtimes = celRuntimes();

  const checkBoolean = Effect.fn("ExpressionEngine.checkBoolean")(
    (source: Source, environment: Environment): Effect.Effect<void, ExpressionCheckError> =>
      checkExpected(runtimes, source, environment, isBooleanType, "bool"),
  );

  const checkScalar = Effect.fn("ExpressionEngine.checkScalar")(
    (source: Source, environment: Environment): Effect.Effect<void, ExpressionCheckError> =>
      checkExpected(
        runtimes,
        source,
        environment,
        (resultType) => acceptedScalarTypes.has(resultType),
        "a scalar value",
      ),
  );

  /** Evaluates an already checked condition on `context`. Fails if the result isn't a boolean. */
  const booleanOn = (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ): Result.Result<boolean, ExpressionEvaluationError> =>
    Result.flatMap(evaluated(runtimes, source, environment, context), (value) =>
      Predicate.isBoolean(value)
        ? Result.succeed(value)
        : Result.fail(unexpectedResult(source, "a boolean")()),
    );

  const evaluateBoolean = Effect.fn("ExpressionEngine.evaluateBoolean")(function* (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) {
    yield* checkBoolean(source, environment);
    return yield* Effect.fromResult(booleanOn(source, environment, context));
  });

  // One span and one check for all contexts; per-context Effects cost several times more (#464).
  const evaluateBooleanEach = Effect.fn("ExpressionEngine.evaluateBooleanEach")(function* (
    source: Source,
    environment: Environment,
    contexts: ReadonlyArray<Schema.JsonObject>,
  ) {
    yield* Effect.annotateCurrentSpan({ contexts: contexts.length });
    yield* checkBoolean(source, environment);
    return contexts.map((context) => booleanOn(source, environment, context));
  });

  const evaluateScalar = Effect.fn("ExpressionEngine.evaluateScalar")(function* (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ) {
    yield* checkScalar(source, environment);
    const value = yield* Effect.fromResult(evaluated(runtimes, source, environment, context));
    return yield* decodeScalar(value).pipe(
      Effect.mapError(unexpectedResult(source, "a scalar value")),
    );
  });

  return ExpressionEngine.of({
    relatedStringLiterals,
    checkBoolean,
    checkScalar,
    evaluateBoolean,
    evaluateBooleanEach,
    evaluateScalar,
  });
};

/**
 * Provides {@link ExpressionEngine} with `@marcbachmann/cel-js` 8.0.0
 * ([ADR 0004](../../../docs/adr/0004-loop-files-markdown-cel-frontmatter.md)).
 *
 * Expressions can use CEL optional values, such as `item.?milestone.?title.orValue("none")`. A
 * nullable field that holds `null` counts as present, so `item.?milestone` holds `null` and
 * `item.?milestone.?title` is empty.
 *
 * Before evaluation, converts JSON integers to `bigint` wherever the {@link Environment}
 * declares `int`, at any depth, and sets absent nullable fields to `null`. Values inside a
 * `map<K,V>` aren't converted, so declare integer map values as `double`.
 *
 * `uint` isn't supported in `context`; declare such values as `int`. An expression that reads a
 * non-nullable `uint` value type-checks but fails evaluation. On a nullable field, comparing with a
 * `uint` literal works but `uint` arithmetic fails. A `uint` result fails `evaluateScalar`.
 */
export const MarcbachmannCelLayer = Layer.sync(ExpressionEngine)(makeExpressionEngine);

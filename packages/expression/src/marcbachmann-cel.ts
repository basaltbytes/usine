import {
  type ASTNode,
  Environment as CelEnvironment,
  ParseError as CelParseError,
  type ParseResult,
  TypeError as CelTypeError,
  type TypeCheckResult,
  parse,
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

type EnvironmentPurpose = "check" | "evaluate";

/**
 * cel-js rejects `null` in a typed field and cannot index `dyn<T>`, so checking
 * keeps a nullable field's type and evaluation declares it `dyn`. Both register
 * `T == null`, from which cel-js derives `!=` and the reversed operand order.
 */
const makeEnvironment = (descriptor: Environment, purpose: EnvironmentPurpose): CelEnvironment => {
  const environment = new CelEnvironment({ unlistedVariablesAreDyn: false });
  const nullableTypes = new Set<TypeReference>();
  for (const objectType of descriptor.types) {
    environment.registerType(objectType.name, {
      fields: Object.fromEntries(
        objectType.fields.map((field) => {
          if (!field.nullable) return [field.name, field.type];
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
    environment.registerVariable(variable.name, variable.type);
  }
  return environment;
};

/**
 * Tells a JSON object from an array, `null`, or another primitive. The context
 * is already `Schema.Json`, so a shallow test is enough.
 * `Schema.is(Schema.JsonObject)` would validate each nested object's whole
 * subtree again at every level of the walk, for every Loop and Item the
 * overview and desk evaluate (#464).
 */
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

/** Turns a JSON value of one declared type into the value cel-js evaluates. */
type Normalize = (value: Schema.Json) => RuntimeValue;

/** A type that needs no normalization: a string, a `map<K,V>`, or an object type with no `int` and no nullable field below it. */
const unchanged: Normalize = (value) => value;

/** A copy of a JSON object whose fields normalization rewrites in place before cel-js reads it. */
interface NormalizedObject {
  [key: string]: RuntimeValue;
}

/** Sets `name` on a copied object as an own field, even when it is `__proto__`. */
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
 * Compiles how a descriptor's evaluation context is normalized, as the layer's
 * documentation describes: `int` and `uint` numbers become `bigint`, `list<T>`
 * normalizes each item as `T`, and an object type normalizes each declared
 * field and reads an absent nullable field as `null`. Each type reference is
 * compiled once. A value whose type needs nothing is returned as it is, and an
 * object is copied with only its fields that change rewritten, so normalizing
 * an Item's payload leaves its strings and undeclared fields untouched.
 */
const contextNormalizer = (
  descriptor: Environment,
): ((context: Schema.JsonObject) => RuntimeObject) => {
  const objectTypes = new Map(descriptor.types.map((type) => [type.name, type]));
  const compiled = new Map<TypeReference, Normalize>();
  // A type comes before the types whose fields reference it, so compiling a
  // field's type never comes back to the type being compiled.
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

/** How many expressions each environment keeps checked or parsed; past that the oldest is dropped. */
const KEPT_EXPRESSIONS = 256;

/** `value` kept under `key` in `kept`, dropping the oldest entry when `kept` is full. */
const keep = <A>(kept: Map<Source, A>, key: Source, value: A): A => {
  if (kept.size >= KEPT_EXPRESSIONS) {
    const oldest = kept.keys().next();
    if (oldest.done !== true) kept.delete(oldest.value);
  }
  kept.set(key, value);
  return value;
};

/** One descriptor's cel-js environments, built on first use, and what they keep between calls. */
interface DescriptorRuntime {
  readonly normalize: (context: Schema.JsonObject) => RuntimeObject;
  check: Option.Option<CelEnvironment>;
  evaluate: Option.Option<CelEnvironment>;
  readonly checked: Map<Source, TypeCheckResult>;
  readonly parsed: Map<Source, ParseResult>;
}

/** Checks and evaluates expressions against descriptors; each call throws what cel-js throws. */
interface CelRuntimes {
  readonly check: (descriptor: Environment, source: Source) => TypeCheckResult;
  readonly evaluate: (
    descriptor: Environment,
    source: Source,
    context: Schema.JsonObject,
  ) => RuntimeValue;
}

/**
 * Builds each descriptor's cel-js environment once per purpose (check or
 * evaluate), and checks and parses each expression once per environment. Building an
 * environment clones cel-js's whole function registry and registers every
 * payload type, and parsing and checking an expression costs more than
 * evaluating it, while the operator's overview and desk evaluate every Loop's
 * trigger on every Board Item each time they are read (#464).
 *
 * A check result depends only on the environment and the expression, so it is
 * kept as it is. A parsed expression is cel-js's `Environment.parse` result,
 * which cel-js evaluates again on each new context; between two evaluations
 * its comprehensions only hold the previous context until the next evaluation
 * replaces it. A build or parse that throws is not kept, and the next call
 * tries again. Each environment keeps its {@link KEPT_EXPRESSIONS} newest expressions.
 * Descriptors are immutable, and the trigger environments are module
 * constants, so they are the keys; a descriptor no caller keeps is released
 * with its environments.
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
      // SAFETY: CEL evaluates to the same value vocabulary the context is built
      // from, and every caller decodes the expected result type before use.
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

const makeExpressionEngine = () => {
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

  /** The value of an already checked condition on `context`, or why it has none. */
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

  // One span and one check for every context: evaluating each context in its own
  // Effect costs several times the evaluation itself, and Loop matching evaluates
  // every Loop's trigger on every Board Item on each operator read (#464).
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
 * Provides {@link ExpressionEngine} on `@marcbachmann/cel-js`, pinned to 8.0.0 as
 * the CEL seam requires
 * ([ADR 0004](../../../docs/adr/0004-loop-files-markdown-cel-frontmatter.md)).
 * The layer has no requirements. Each built layer sets up the cel-js
 * environment of an {@link Environment} once for checking and once for
 * evaluation, the first time an expression needs it, and reuses it for every
 * later call with the same descriptor. It also keeps each expression's check
 * result and parsed form per environment, so checking or evaluating the same
 * expression again, on any context, does not parse it again. Before evaluation it converts JSON integers to
 * `bigint` where the {@link Environment} declares `int`: on a variable, on a
 * field of a declared object type, or as the item type of a `list<T>`, at any
 * depth. It also reads absent nullable fields of declared object types as
 * `null`. It does not convert values inside a `map<K,V>`, so reading a JSON
 * integer from a `map<string,int>` fails evaluation because the value is a
 * `double`. Declare such map values as `double`.
 *
 * `uint` is not supported for `context` values. An expression that reads a
 * variable, non-nullable object field, or list item declared `uint` passes
 * checking but fails evaluation, because the value arrives as a signed
 * integer. A nullable field is evaluated as `dyn`, so a `uint` value read
 * from it, or from a list it holds, arrives as the signed integer: comparing
 * it with a `uint` literal works, but `uint` arithmetic on it fails
 * evaluation. Declare such values as `int`. A `uint` result fails
 * `evaluateScalar` (see {@link Scalar}).
 */
export const MarcbachmannCelLayer = Layer.sync(ExpressionEngine)(makeExpressionEngine);

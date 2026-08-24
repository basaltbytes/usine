import {
  Environment as CelEnvironment,
  ParseError as CelParseError,
  TypeError as CelTypeError,
} from "@marcbachmann/cel-js";
import { Effect, Layer, Option, Schema } from "effect";
import { ExpressionEngine } from "./expression-engine.ts";
import {
  CheckError,
  type Environment,
  EvaluationError,
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

const checkFailure = (source: Source, error: VendorCheckError | undefined): CheckError =>
  error === undefined
    ? new CheckError({
        source,
        code: "check_failed",
        message: "CEL check failed without an error detail",
        position: Option.none(),
      })
    : new CheckError({
        source,
        code: error instanceof CelParseError ? "parse_error" : "type_error",
        message: error.message,
        position: Option.fromNullishOr(error.range?.start),
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
): Effect.Effect<void, CheckError> =>
  Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () => makeEnvironment(environment).check(source),
      catch: (cause) =>
        new CheckError({
          source,
          code: "check_failed",
          message: messageFromCause(cause, "CEL check failed"),
          position: Option.none(),
        }),
    });
    if (!result.valid) return yield* checkFailure(source, result.error);
    const resultType = result.type;
    if (resultType === undefined || !accepts(resultType)) {
      return yield* new CheckError({
        source,
        code: "unexpected_result_type",
        message: `Expected ${expected}, got ${resultType ?? "an unknown type"}`,
        position: Option.none(),
      });
    }
  });

const checkBoolean = Effect.fn("ExpressionEngine.checkBoolean")(
  (source: Source, environment: Environment): Effect.Effect<void, CheckError> =>
    checkExpected(source, environment, (resultType) => resultType === "bool", "bool"),
);

const checkScalar = Effect.fn("ExpressionEngine.checkScalar")(
  (source: Source, environment: Environment): Effect.Effect<void, CheckError> =>
    checkExpected(
      source,
      environment,
      (resultType) => acceptedScalarTypes.has(resultType),
      "a scalar value",
    ),
);

const evaluateBoolean = Effect.fn("ExpressionEngine.evaluateBoolean")(
  (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ): Effect.Effect<boolean, CheckError | EvaluationError> =>
    Effect.gen(function* () {
      yield* checkBoolean(source, environment);
      return yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(Schema.Boolean)(
            makeEnvironment(environment).evaluate(source, normalizeContext(context, environment)),
          ),
        catch: (cause) =>
          new EvaluationError({
            source,
            message: messageFromCause(cause, "CEL evaluation failed"),
          }),
      });
    }),
);

const evaluateScalar = Effect.fn("ExpressionEngine.evaluateScalar")(
  (
    source: Source,
    environment: Environment,
    context: Schema.JsonObject,
  ): Effect.Effect<Scalar, CheckError | EvaluationError> =>
    Effect.gen(function* () {
      yield* checkScalar(source, environment);
      return yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(Scalar)(
            makeEnvironment(environment).evaluate(source, normalizeContext(context, environment)),
          ),
        catch: (cause) =>
          new EvaluationError({
            source,
            message: messageFromCause(cause, "CEL evaluation failed"),
          }),
      });
    }),
);

/** Live CEL adapter backed by the exact-pinned @marcbachmann/cel-js implementation. */
export const MarcbachmannCelLayer = Layer.succeed(ExpressionEngine, {
  checkBoolean,
  checkScalar,
  evaluateBoolean,
  evaluateScalar,
});

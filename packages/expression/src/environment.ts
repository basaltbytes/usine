import { Effect, Schema } from "effect";

/**
 * A type name in CEL syntax: a primitive such as `string` or `int`, an object
 * type such as `Label`, `list<T>`, or `map<K,V>`, with no spaces. Decoding checks
 * the syntax only. A name that no {@link ObjectType} declares fails when an
 * expression is checked.
 */
export const TypeReference = Schema.String.check(
  Schema.isPattern(
    /^(?:[A-Za-z_][A-Za-z0-9_.]*|list<[A-Za-z_][A-Za-z0-9_.]*>|map<[A-Za-z_][A-Za-z0-9_.]*,[A-Za-z_][A-Za-z0-9_.]*>)$/u,
    { message: "Expected a CEL type reference" },
  ),
).pipe(Schema.brand("CelTypeReference"));
export type TypeReference = typeof TypeReference.Type;

const Identifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u, { message: "Expected a CEL identifier" }),
);

const ObjectTypeName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_.]*$/u, {
    message: "Expected a CEL object-type name",
  }),
);

const uniqueNames = (message: string) =>
  Schema.makeFilter<ReadonlyArray<{ readonly name: string }>>(
    (values) => new Set(values.map(({ name }) => name)).size === values.length,
    { message },
  );

/**
 * One named field and its CEL type within an object descriptor. A nullable
 * field holds `null` or a value of its type, and an absent key reads as `null`.
 * Expressions can compare it with `null`, while reads below it stay typed.
 */
export class ObjectField extends Schema.Class<ObjectField>("@usine/expression/ObjectField")({
  /** The key expressions read after a dot, such as `title` in `item.title`. A CEL identifier. */
  name: Identifier,
  /** The CEL type of the field's value when it is present and not `null`. */
  type: TypeReference,
  /**
   * Whether the field can hold `null` or be absent from the payload. Defaults
   * to `false` when constructing. Reading an absent non-nullable field fails
   * evaluation.
   */
  nullable: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
}) {}

/**
 * A named object type expressions can read fields from, such as the
 * `IssuePayload` type of a payload slice. Declare a type before the types that
 * reference it. Field names must be unique within the type.
 */
export class ObjectType extends Schema.Class<ObjectType>("@usine/expression/ObjectType")({
  /**
   * The name a {@link TypeReference} uses to refer to this type, such as
   * `Label`. Dots are allowed for qualified names.
   */
  name: ObjectTypeName,
  /** The fields expressions can read on a value of this type, each name used once. */
  fields: Schema.Array(ObjectField).check(uniqueNames("Expected unique CEL object-field names")),
}) {}

/**
 * A root variable available to CEL expressions in an {@link Environment}, such
 * as `repo` or `item`. Evaluation reads its value from the `context` entry of
 * the same name.
 */
export class Variable extends Schema.Class<Variable>("@usine/expression/Variable")({
  /** The identifier expressions use for the variable, and its key in `context`. */
  name: Identifier,
  /** The CEL type of the variable's value, usually one of the environment's object types. */
  type: TypeReference,
}) {}

/**
 * The types and root variables an expression is checked and evaluated against.
 * Object-type names and variable names must each be unique. Expressions that
 * name anything outside this environment fail checking.
 */
export class Environment extends Schema.Class<Environment>("@usine/expression/Environment")({
  /**
   * The object types expressions can use, in declaration order: a type comes
   * before the types whose fields reference it.
   */
  types: Schema.Array(ObjectType).check(uniqueNames("Expected unique CEL object-type names")),
  /** The root variables expressions can name, such as `repo` and `item`. */
  variables: Schema.Array(Variable).check(uniqueNames("Expected unique CEL variable names")),
}) {}

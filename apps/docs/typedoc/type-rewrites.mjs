// @ts-check
import {
  ArrayType,
  ConditionalType,
  IndexedAccessType,
  IntersectionType,
  LiteralType,
  MappedType,
  NamedTupleMember,
  OptionalType,
  PredicateType,
  QueryType,
  ReferenceType,
  RestType,
  TupleType,
  TypeOperatorType,
  UnionType,
  UnknownType,
} from "typedoc";

/**
 * Walks `type` bottom-up and replaces each node for which `replace` returns a type. Composite
 * types are updated in place, which keeps the details TypeDoc stores on them, such as the
 * comments of union members. Types inside an object literal are left alone: its members are
 * reflections of their own.
 *
 * @param {import("typedoc").SomeType} type
 * @param {(type: import("typedoc").SomeType) => import("typedoc").SomeType | undefined} replace
 * @returns {import("typedoc").SomeType}
 */
function mapType(type, replace) {
  /** @param {import("typedoc").SomeType} inner */
  const map = (inner) => mapType(inner, replace);
  if (type instanceof ArrayType || type instanceof OptionalType || type instanceof RestType) {
    type.elementType = map(type.elementType);
  } else if (type instanceof UnionType || type instanceof IntersectionType) {
    type.types = type.types.map(map);
  } else if (type instanceof TupleType) {
    type.elements = type.elements.map(map);
  } else if (type instanceof NamedTupleMember) {
    type.element = map(type.element);
  } else if (type instanceof TypeOperatorType) {
    type.target = map(type.target);
  } else if (type instanceof IndexedAccessType) {
    type.objectType = map(type.objectType);
    type.indexType = map(type.indexType);
  } else if (type instanceof ConditionalType) {
    type.checkType = map(type.checkType);
    type.extendsType = map(type.extendsType);
    type.trueType = map(type.trueType);
    type.falseType = map(type.falseType);
  } else if (type instanceof MappedType) {
    type.parameterType = map(type.parameterType);
    type.templateType = map(type.templateType);
  } else if (type instanceof PredicateType && type.targetType !== undefined) {
    type.targetType = map(type.targetType);
  } else if (type instanceof ReferenceType && type.typeArguments !== undefined) {
    type.typeArguments = type.typeArguments.map(map);
  }
  return replace(type) ?? type;
}

/**
 * Applies `replace` to every type of every reflection in the project.
 *
 * @param {import("typedoc").ProjectReflection} project
 * @param {(type: import("typedoc").SomeType, owner: import("typedoc").Reflection) => import("typedoc").SomeType | undefined} replace
 */
function mapProjectTypes(project, replace) {
  for (const reflection of Object.values(project.reflections)) {
    /** @param {import("typedoc").SomeType} type */
    const map = (type) => mapType(type, (inner) => replace(inner, reflection));
    if (
      (reflection.isDeclaration() || reflection.isParameter() || reflection.isSignature()) &&
      reflection.type !== undefined
    ) {
      reflection.type = map(reflection.type);
    }
    if (reflection.isTypeParameter()) {
      if (reflection.type !== undefined) reflection.type = map(reflection.type);
      if (reflection.default !== undefined) reflection.default = map(reflection.default);
    }
  }
}

/**
 * The value of a string literal type, such as `RunId` for `"RunId"`.
 *
 * @param {import("typedoc").SomeType | undefined} type
 */
const stringLiteral = (type) =>
  type instanceof LiteralType && type.toString().startsWith('"') ? String(type.value) : undefined;

/**
 * The names in the `Brand<"X">` parts of a branded type such as `string & Brand<"RunId">`.
 *
 * @param {import("typedoc").SomeType} type
 */
const brandNames = (type) =>
  type instanceof IntersectionType
    ? type.types.flatMap((part) => {
        const name =
          part instanceof ReferenceType && part.name === "Brand" && part.typeArguments?.length === 1
            ? stringLiteral(part.typeArguments[0])
            : undefined;
        return name === undefined ? [] : [name];
      })
    : [];

/**
 * The brand names of the type a type alias declares, such as `RunId` for
 * `type RunId = typeof RunId.Type`, which is `string & Brand<"RunId">`.
 *
 * @param {import("typescript").TypeChecker} checker
 * @param {import("typescript").Symbol | undefined} symbol
 */
export function aliasBrandNames(checker, symbol) {
  if (symbol === undefined) return [];
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  if (!type.isIntersection()) return [];
  return type.types.flatMap((part) => {
    if (part.getSymbol()?.name !== "Brand") return [];
    const [name] = checker.getTypeArguments(
      /** @type {import("typescript").TypeReference} */ (part),
    );
    return name?.isStringLiteral() ? [name.value] : [];
  });
}

/**
 * Shows a branded type by the name of the type alias that declares it: `RunId` instead of
 * `string & Brand<"RunId">`. TypeDoc expands the brand when it reads a type from the checker
 * rather than from a type annotation, as for the fields of a `Schema.Class`.
 *
 * @param {import("typedoc").ProjectReflection} project
 * @param {Map<import("typedoc").DeclarationReflection, string[]>} aliasBrands The brand names of
 *   each type alias that declares a branded type.
 */
export function nameBrandedTypes(project, aliasBrands) {
  /** @type {Map<string, import("typedoc").DeclarationReflection>} */
  const aliases = new Map();
  for (const [alias, brands] of aliasBrands) {
    const key = brands.toSorted().join(" & ");
    const current = aliases.get(key);
    if (current === undefined || (!brands.includes(current.name) && brands.includes(alias.name))) {
      aliases.set(key, alias);
    }
  }
  mapProjectTypes(project, (type, owner) => {
    const brands = brandNames(type);
    if (brands.length === 0) return undefined;
    const alias = aliases.get(brands.toSorted().join(" & "));
    if (alias === undefined || alias === owner) return undefined;
    return ReferenceType.createResolvedReference(alias.name, alias, project);
  });
}

/**
 * Shows the schema type `Schema.decodeTo<Schema.declareConstructor<X, …>, …>` that TypeScript
 * writes for a `Schema.Class` named `X` as `typeof X`.
 *
 * @param {import("typedoc").SomeType} type
 */
export function nameClassSchemas(type) {
  return mapType(type, (inner) => {
    if (!(inner instanceof ReferenceType) || inner.name !== "Schema.decodeTo") return undefined;
    const declared = inner.typeArguments?.[0];
    if (!(declared instanceof ReferenceType) || declared.name !== "Schema.declareConstructor") {
      return undefined;
    }
    const schemaClass = declared.typeArguments?.[0];
    if (!(schemaClass instanceof ReferenceType) || schemaClass.reflection === undefined) {
      return undefined;
    }
    return new QueryType(schemaClass);
  });
}

/**
 * @typedef {object} HttpApiEndpoint
 * @property {string} group
 * @property {string} name
 * @property {string} method
 * @property {string} path
 */

/**
 * Shortens the type of an `HttpApi.HttpApi` constant to its id and group names, and returns its
 * endpoints. TypeScript writes the whole API into the type: several kilobytes on one line.
 *
 * @param {import("typedoc").DeclarationReflection} reflection
 * @returns {HttpApiEndpoint[] | undefined}
 */
export function shortenHttpApi(reflection) {
  const type = reflection.type;
  if (!(type instanceof ReferenceType) || type.name !== "HttpApi.HttpApi") return undefined;
  /** @type {HttpApiEndpoint[]} */
  const endpoints = [];
  /** @type {ReferenceType[]} */
  const groups = [];
  mapType(type, (inner) => {
    if (!(inner instanceof ReferenceType)) return undefined;
    if (inner.name === "HttpApiGroup.HttpApiGroup") {
      const group = stringLiteral(inner.typeArguments?.[0]) ?? "";
      groups.push(inner);
      /** @param {import("typedoc").SomeType} member */
      const collect = (member) => {
        if (member instanceof UnionType) {
          member.types.forEach(collect);
          return;
        }
        if (
          !(member instanceof ReferenceType) ||
          member.name !== "HttpApiEndpoint.HttpApiEndpoint"
        ) {
          return;
        }
        const [name, method, path] = (member.typeArguments ?? []).map(stringLiteral);
        if (name !== undefined && method !== undefined && path !== undefined) {
          endpoints.push({ group, name, method, path });
        }
      };
      if (inner.typeArguments?.[1] !== undefined) collect(inner.typeArguments[1]);
    }
    return undefined;
  });
  const ellipsis = new UnknownType("…");
  for (const group of groups) {
    group.typeArguments = [...(group.typeArguments ?? []).slice(0, 1), ellipsis];
  }
  const [onlyGroup] = groups;
  const groupsType = groups.length > 1 ? new UnionType(groups) : (onlyGroup ?? ellipsis);
  type.typeArguments = [...(type.typeArguments ?? []).slice(0, 1), groupsType];
  return endpoints;
}

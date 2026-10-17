// @ts-check
import {
  Comment,
  CommentTag,
  DeclarationReflection,
  ParameterReflection,
  ReferenceType,
  ReflectionFlag,
  ReflectionKind,
  ReflectionType,
} from "typedoc";
import ts from "typescript";

/**
 * @typedef {object} HiddenBase
 * @property {string} name The unexported constant, such as `Run_base`.
 * @property {string} typeName The constant's type as written, such as `Schema.Class`.
 * @property {"schema" | "service" | "middleware"} kind
 * @property {ts.TypeReferenceNode} type
 */

/**
 * The unexported constant a class extends in its declaration file, for the three Effect class
 * builders the packages use. TypeScript emits one when the source class extends an expression:
 * `class Run extends Schema.Class<Run>("Run")({…})` becomes `declare const Run_base:
 * Schema.Class<…>` and `class Run extends Run_base`.
 *
 * @param {ts.TypeChecker} checker
 * @param {ts.Symbol | undefined} symbol
 * @returns {HiddenBase | undefined}
 */
export function hiddenBase(checker, symbol) {
  const heritage = symbol?.declarations
    ?.find(ts.isClassDeclaration)
    ?.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
  if (heritage === undefined) return undefined;
  const base = checker.getSymbolAtLocation(heritage.expression)?.valueDeclaration;
  if (
    base === undefined ||
    !ts.isVariableDeclaration(base) ||
    !ts.isIdentifier(base.name) ||
    base.type === undefined ||
    !ts.isTypeReferenceNode(base.type) ||
    ts.getCombinedModifierFlags(base) & ts.ModifierFlags.Export
  ) {
    return undefined;
  }
  const kind = baseKind(checker, base.type);
  if (kind === undefined) return undefined;
  return { name: base.name.text, typeName: base.type.typeName.getText(), kind, type: base.type };
}

/**
 * @param {ts.TypeChecker} checker
 * @param {ts.TypeReferenceNode} baseType
 */
function baseKind(checker, baseType) {
  let target = checker.getSymbolAtLocation(baseType.typeName);
  if (target !== undefined && target.flags & ts.SymbolFlags.Alias) {
    target = checker.getAliasedSymbol(target);
  }
  const files = (target?.declarations ?? []).map((declaration) =>
    declaration.getSourceFile().fileName.split("\\").join("/"),
  );
  /** @param {string} file */
  const declaredIn = (file) => files.some((name) => name.endsWith(`/effect/dist/${file}`));
  if (target?.name === "Class" && declaredIn("Schema.d.ts")) return "schema";
  if (target?.name === "ServiceClass" && declaredIn("Context.d.ts")) return "service";
  if (target?.name === "ServiceClass" && declaredIn("unstable/httpapi/HttpApiMiddleware.d.ts")) {
    return "middleware";
  }
  return undefined;
}

/**
 * An object type under the class that contains the members this plugin adds to it until
 * `moveMembers` moves them into the class. For a member created directly under the class, TypeDoc
 * looks up the member in the class's instance type to find where it's inherited from, and warns.
 *
 * @param {import("typedoc").Context} context
 * @param {DeclarationReflection} reflection
 */
function memberHolder(context, reflection) {
  const holder = new DeclarationReflection("__type", ReflectionKind.TypeLiteral, reflection);
  context.registerReflection(holder, undefined);
  return holder;
}

/**
 * Converts the operations of a `Context.ServiceClass<Self, Key, Operations>` base. They are what
 * `yield* Service` returns, and the class only exposes them as the `Service` member declared in
 * Effect, which TypeDoc leaves out as external.
 *
 * @param {import("typedoc").Context} context
 * @param {DeclarationReflection} reflection
 * @param {HiddenBase} base
 */
export function serviceOperations(context, reflection, base) {
  const holder = memberHolder(context, reflection);
  const operations = base.type.typeArguments?.[2];
  if (operations === undefined) return holder;
  const holderContext = context.withScope(reflection).withScope(holder);
  for (const property of context.checker.getPropertiesOfType(
    context.checker.getTypeFromTypeNode(operations),
  )) {
    context.converter.convertSymbol(holderContext, property);
  }
  return holder;
}

const middlewareConfigurationDescriptions = new Map([
  [
    "error",
    "The errors the middleware can fail with. Every endpoint that uses it can fail with them.",
  ],
  ["security", "The security schemes the middleware reads credentials from."],
  ["provides", "The services the middleware provides to endpoint handlers."],
  ["requires", "The services the middleware requires."],
  ["clientError", "The errors the client middleware can fail with."],
  ["requiredForClient", "Whether generated clients must provide a matching client middleware."],
]);

/**
 * Converts the configuration of an `HttpApiMiddleware.ServiceClass<Self, Id, Config>` base,
 * leaving out the entries typed `never`.
 *
 * @param {import("typedoc").Context} context
 * @param {DeclarationReflection} reflection
 * @param {HiddenBase} base
 */
export function middlewareConfiguration(context, reflection, base) {
  const holder = memberHolder(context, reflection);
  const configuration = base.type.typeArguments?.[2];
  if (configuration === undefined || !ts.isTypeLiteralNode(configuration)) return holder;
  const holderContext = context.withScope(reflection).withScope(holder);
  for (const member of configuration.members) {
    if (
      !ts.isPropertySignature(member) ||
      member.type === undefined ||
      member.type.kind === ts.SyntaxKind.NeverKeyword ||
      !ts.isIdentifier(member.name)
    ) {
      continue;
    }
    const property = holderContext.createDeclarationReflection(
      ReflectionKind.Property,
      undefined,
      undefined,
      member.name.text,
    );
    property.setFlag(ReflectionFlag.Readonly);
    const description = middlewareConfigurationDescriptions.get(member.name.text);
    if (description !== undefined)
      property.comment = new Comment([{ kind: "text", text: description }]);
    property.type = context.converter.convertType(holderContext.withScope(property), member.type);
    holderContext.finalizeDeclarationReflection(property);
  }
  return holder;
}

/**
 * Moves the members of `holder` into its class under the group `group`, described by
 * `description`. A property whose type is a function, such as `readonly detail: (runId) =>
 * Effect<…>`, becomes a method, so its parameters and return type are headings one level below it.
 *
 * @param {import("typedoc").ProjectReflection} project
 * @param {DeclarationReflection} holder
 * @param {string} group
 * @param {import("typedoc").CommentDisplayPart[]} description
 */
export function moveMembers(project, holder, group, description) {
  const target = holder.parent;
  const members = holder.children ?? [];
  if (!(target instanceof DeclarationReflection)) return;
  holder.children = [];
  holder.childrenIncludingDocuments = [];
  for (const member of members) {
    member.parent = target;
    target.addChild(member);
  }
  // Removing a reflection also removes the reflections whose parent it still is.
  project.removeReflection(holder);
  if (members.length === 0) return;
  for (const member of members) {
    propertyToMethod(project, member);
    for (const owner of member.signatures ?? [member]) {
      owner.comment ??= new Comment();
      owner.comment.blockTags.push(new CommentTag("@group", [{ kind: "text", text: group }]));
    }
  }
  target.comment ??= new Comment();
  target.comment.blockTags.push(
    new CommentTag("@groupDescription", [{ kind: "text", text: `${group}\n` }, ...description]),
  );
}

/**
 * @param {import("typedoc").ProjectReflection} project
 * @param {DeclarationReflection} property
 */
function propertyToMethod(project, property) {
  const declaration =
    property.type instanceof ReflectionType ? property.type.declaration : undefined;
  const signatures = declaration?.signatures ?? [];
  if (
    declaration === undefined ||
    signatures.length === 0 ||
    (declaration.children ?? []).length > 0 ||
    (declaration.indexSignatures ?? []).length > 0
  ) {
    return;
  }
  declaration.signatures = [];
  for (const signature of signatures) {
    signature.parent = property;
    signature.name = property.name;
    signature.comment ??= property.comment?.clone();
  }
  project.removeReflection(declaration);
  property.kind = ReflectionKind.Method;
  delete property.type;
  property.signatures = signatures;
  delete property.comment;
}

/**
 * Replaces the `...args: [props: object, options?: MakeOptions]` parameter of a `Schema.Class`
 * constructor with `props`, listing the properties the constructor takes, and `options`.
 *
 * @param {import("typedoc").Context} context
 * @param {import("typedoc").SignatureReflection} signature
 * @param {ts.Signature} tsSignature
 */
export function spreadSchemaConstructorArguments(context, signature, tsSignature) {
  const { checker } = context;
  const [rest] = tsSignature.parameters;
  if (rest === undefined || tsSignature.parameters.length !== 1) return;
  const tuple = checker.getTypeOfSymbol(rest);
  if (!isTupleReference(checker, tuple)) return;
  const elements = checker.getTypeArguments(tuple);
  const signatureContext = context.withScope(signature);
  const parameters = elements.map((elementType, index) => {
    const label = tuple.target.labeledElementDeclarations?.[index]?.name;
    const name = label !== undefined && ts.isIdentifier(label) ? label.text : `argument${index}`;
    const parameter = new ParameterReflection(name, ReflectionKind.Parameter, signature);
    context.registerReflection(parameter, undefined);
    if ((tuple.target.elementFlags[index] ?? 0) & ts.ElementFlags.Optional) {
      parameter.setFlag(ReflectionFlag.Optional);
    }
    const parameterContext = signatureContext.withScope(parameter);
    parameter.type =
      name === "props"
        ? objectType(parameterContext, elementType)
        : context.converter.convertType(parameterContext, elementType);
    return parameter;
  });
  for (const parameter of signature.parameters ?? []) context.project.removeReflection(parameter);
  signature.parameters = parameters;
  // The constructor returns the class it documents; without a type it gets no "Returns" section.
  delete signature.type;
}

/**
 * @param {ts.TypeChecker} checker
 * @param {ts.Type} type
 * @returns {type is ts.TupleTypeReference}
 */
function isTupleReference(checker, type) {
  return checker.isTupleType(type);
}

/**
 * An object type listing each property of `type` with the type the checker resolves for it.
 * TypeDoc renders the `props` type of a `Schema.Class` constructor as `object`, because the type
 * is the result of mapped types and has no symbol of its own. Its kind is `Interface` rather than
 * `TypeLiteral`, so the parameters table shows it in one row instead of one row per property.
 *
 * @param {import("typedoc").Context} context
 * @param {ts.Type} type
 */
function objectType(context, type) {
  const declaration = new DeclarationReflection("__type", ReflectionKind.Interface, context.scope);
  context.registerReflection(declaration, undefined);
  const declarationContext = context.withScope(declaration);
  for (const property of context.checker.getPropertiesOfType(type)) {
    const child = new DeclarationReflection(property.name, ReflectionKind.Property, declaration);
    context.registerReflection(child, undefined);
    if (property.flags & ts.SymbolFlags.Optional) child.setFlag(ReflectionFlag.Optional);
    child.type = context.converter.convertType(
      declarationContext.withScope(child),
      context.checker.getTypeOfSymbol(property),
    );
    declaration.addChild(child);
  }
  return new ReflectionType(declaration);
}

/**
 * Removes the hidden base from the class: the class extends the base's type instead
 * (`Schema.Class`), its members are no longer marked as inherited from the base, and a service or
 * middleware class loses its constructor, which takes `never` because layers provide services.
 *
 * @param {import("typedoc").ProjectReflection} project
 * @param {DeclarationReflection} reflection
 * @param {HiddenBase} base
 */
export function replaceHiddenBase(project, reflection, base) {
  reflection.extendedTypes = [
    ReferenceType.createBrokenReference(base.typeName, project, undefined),
  ];
  for (const member of reflection.children ?? []) {
    for (const inherited of [member, ...member.getAllSignatures()]) {
      if (inherited.inheritedFrom?.name.startsWith(`${base.name}.`)) {
        delete inherited.inheritedFrom;
      }
    }
  }
  if (base.kind === "service" || base.kind === "middleware") {
    for (const constructor of reflection.getChildrenByKind(ReflectionKind.Constructor)) {
      project.removeReflection(constructor);
    }
  }
}

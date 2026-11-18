import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";

/** Resolves named, aliased, default, and namespace React imports without matching shadowed names. */
export const reactImport = (source: SourceCode, callee: ESTree.Expression): string | undefined => {
  const identifier =
    callee.type === "Identifier"
      ? callee
      : callee.type === "MemberExpression" && callee.object.type === "Identifier"
        ? callee.object
        : undefined;
  if (identifier === undefined) return;
  let scope: Scope | null = source.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      const definition = variable.defs[0];
      if (
        definition?.type !== "ImportBinding" ||
        definition.parent?.type !== "ImportDeclaration" ||
        definition.parent.source.value !== "react"
      )
        return;
      const specifier = definition.node;
      if (callee.type === "Identifier" && specifier.type === "ImportSpecifier") {
        return specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value;
      }
      if (callee.type === "MemberExpression" && specifier.type !== "ImportSpecifier") {
        if (!callee.computed && callee.property.type === "Identifier") return callee.property.name;
        if (
          callee.computed &&
          callee.property.type === "Literal" &&
          typeof callee.property.value === "string"
        )
          return callee.property.value;
      }
      return;
    }
    scope = scope.upper;
  }
};

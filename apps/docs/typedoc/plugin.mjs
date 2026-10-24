// @ts-check
import { Comment, Converter, ReflectionKind, RendererEvent } from "typedoc";
import {
  hiddenBase,
  middlewareConfiguration,
  moveMembers,
  replaceHiddenBase,
  serviceOperations,
  spreadSchemaConstructorArguments,
} from "./effect-classes.mjs";
import {
  linkRepositoryFilesToGitHub,
  nestModulesByPackage,
  sourceFileUrl,
  splitLargeModules,
} from "./package-modules.mjs";
import {
  aliasBrandNames,
  nameBrandedTypes,
  nameClassSchemas,
  shortenHttpApi,
} from "./type-rewrites.mjs";

/**
 * Registers TypeDoc handlers that change the API reference:
 *
 * - Nests entry modules under one module per package, so each package has a page that lists its
 *   subpaths and each subpath has a page at `<package>/<subpath>`. A package's root export (`.`)
 *   is the package module. Page titles are import specifiers.
 * - Shows a class built with `Schema.Class`, `Context.Service`, or `HttpApiMiddleware.Service` as
 *   extending that builder's type instead of the hidden `X_base` constant. A schema class's
 *   constructor lists its properties, a service class lists its operations as methods, and a
 *   middleware class lists its configuration.
 * - Shows branded types by their alias name: `RunId`, not `string & Brand<"RunId">`.
 * - Shows an `HttpApi` constant's ID and groups, and a table of its endpoints.
 * - Splits a subpath with many members re-exported from other files into one page per file.
 * - Points relative links in comments to the file on GitHub.
 *
 * @param {import("typedoc").Application} app
 */
export function load(app) {
  /** @type {Map<import("typedoc").DeclarationReflection, import("./effect-classes.mjs").HiddenBase>} */
  const hiddenBases = new Map();
  /** @type {import("typedoc").DeclarationReflection[]} */
  const serviceHolders = [];
  /** @type {import("typedoc").DeclarationReflection[]} */
  const middlewareHolders = [];
  /** @type {Map<import("typedoc").Reflection, string>} */
  const declarationFiles = new Map();
  /** @type {Map<import("typedoc").DeclarationReflection, string[]>} */
  const aliasBrands = new Map();
  /** @type {import("./package-modules.mjs").ModuleTitle[]} */
  const titles = [];

  app.converter.on(Converter.EVENT_CREATE_DECLARATION, (context, reflection) => {
    const symbol = context.getSymbolFromReflection(reflection);
    const file = symbol?.declarations?.[0]?.getSourceFile().fileName;
    if (file !== undefined && reflection.parent?.kindOf(ReflectionKind.Module)) {
      declarationFiles.set(reflection, file);
    }
    if (reflection.kindOf(ReflectionKind.TypeAlias)) {
      const brands = aliasBrandNames(context.checker, symbol);
      if (brands.length > 0) aliasBrands.set(reflection, brands);
    }
    if (!reflection.kindOf(ReflectionKind.Class)) return;
    const base = hiddenBase(context.checker, symbol);
    if (base === undefined) return;
    hiddenBases.set(reflection, base);
    if (base.kind === "service") serviceHolders.push(serviceOperations(context, reflection, base));
    if (base.kind === "middleware") {
      middlewareHolders.push(middlewareConfiguration(context, reflection, base));
    }
  });

  app.converter.on(Converter.EVENT_CREATE_SIGNATURE, (context, signature, _node, tsSignature) => {
    const owner = signature.parent?.parent;
    if (
      signature.kind === ReflectionKind.ConstructorSignature &&
      tsSignature !== undefined &&
      owner?.isDeclaration() &&
      hiddenBases.get(owner)?.kind === "schema"
    ) {
      spreadSchemaConstructorArguments(context, signature, tsSignature);
    }
  });

  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, ({ project }) => {
    for (const [reflection, base] of hiddenBases) replaceHiddenBase(project, reflection, base);
    for (const holder of serviceHolders) {
      const name = holder.parent?.name ?? "";
      moveMembers(project, holder, "Service operations", [
        { kind: "text", text: "What " },
        { kind: "code", text: `\`yield* ${name}\`` },
        { kind: "text", text: " returns, typed " },
        { kind: "code", text: `\`${name}["Service"]\`` },
        { kind: "text", text: "." },
      ]);
    }
    for (const holder of middlewareHolders) {
      for (const property of holder.children ?? []) {
        if (property.type !== undefined) property.type = nameClassSchemas(property.type);
      }
      moveMembers(project, holder, "Middleware configuration", [
        { kind: "text", text: "The configuration that endpoints using this middleware inherit." },
      ]);
    }
    for (const [reflection, file] of declarationFiles) {
      if (!reflection.isDeclaration() || !reflection.kindOf(ReflectionKind.Variable)) continue;
      const endpoints = shortenHttpApi(reflection);
      if (endpoints !== undefined) describeEndpoints(reflection, endpoints, sourceFileUrl(file));
    }
    nameBrandedTypes(project, aliasBrands);
    const entryModules = nestModulesByPackage(project);
    titles.splice(
      0,
      titles.length,
      ...entryModules,
      ...splitLargeModules(project, entryModules, declarationFiles),
    );
    hiddenBases.clear();
    serviceHolders.length = 0;
    middlewareHolders.length = 0;
    declarationFiles.clear();
    aliasBrands.clear();
  });

  // TypeDoc builds URLs from the short module names (`core`, `run`) before this event.
  app.renderer.on(RendererEvent.BEGIN, ({ project }) => {
    linkRepositoryFilesToGitHub(project);
    for (const { module, title } of titles) module.name = title;
    for (const reflection of Object.values(project.reflections)) {
      if (reflection.isDeclaration()) placeGroupsAfterConstructors(reflection, addedGroups);
    }
  });
}

const addedGroups = new Set(["Service operations", "Middleware configuration"]);

/**
 * Moves the groups named in `leading` right after the constructors. TypeDoc sorts groups it
 * doesn't know after the ones it does, such as a service class's static `layer` property.
 *
 * @param {import("typedoc").DeclarationReflection} reflection
 * @param {Set<string>} leading
 */
function placeGroupsAfterConstructors(reflection, leading) {
  const groups = reflection.groups ?? [];
  const moved = groups.filter(({ title }) => leading.has(title));
  if (moved.length === 0) return;
  const rest = groups.filter(({ title }) => !leading.has(title));
  const position = rest.findIndex(({ title }) => title === "Constructors") + 1;
  reflection.groups = [...rest.slice(0, position), ...moved, ...rest.slice(position)];
}

/**
 * Appends a table of the endpoints of an `HttpApi` constant to its comment, and a link to the
 * source file that defines them.
 *
 * @param {import("typedoc").DeclarationReflection} reflection
 * @param {import("./type-rewrites.mjs").HttpApiEndpoint[]} endpoints
 * @param {string | undefined} sourceUrl
 */
function describeEndpoints(reflection, endpoints, sourceUrl) {
  const groups = new Set(endpoints.map(({ group }) => group));
  const withGroup = groups.size > 1;
  const header = withGroup
    ? ["Group", "Endpoint", "Method", "Path"]
    : ["Endpoint", "Method", "Path"];
  const rows = endpoints.map(({ group, name, method, path }) =>
    [...(withGroup ? [group] : []), name, method, path].map((cell) => `\`${cell}\``),
  );
  const table = [header, header.map(() => "---"), ...rows]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
  const intro = withGroup
    ? "Endpoints:"
    : `Endpoints, all in the \`${[...groups][0] ?? ""}\` group:`;
  const source =
    sourceUrl === undefined
      ? ""
      : `\n\nDefined in [${sourceUrl.replace(/^.*\/blob\/main\//, "")}](${sourceUrl}).`;
  reflection.comment ??= new Comment([]);
  reflection.comment.summary.push({ kind: "text", text: `\n\n${intro}\n\n${table}${source}` });
}

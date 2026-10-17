// @ts-check
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Comment,
  Converter,
  DeclarationReflection,
  ReferenceType,
  Reflection,
  ReflectionFlag,
  ReflectionKind,
  RendererEvent,
} from "typedoc";
import ts from "typescript";

const docsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(docsDirectory, "../..");
const repositoryFileUrl = "https://github.com/basaltbytes/usine/blob/main/";

/**
 * Every `@usine/*` devDependency of the docs site, with the declaration file behind each subpath
 * of its `exports` map. `directoryName` names the package's folder in the generated pages.
 */
export const documentedPackages = Object.keys(
  JSON.parse(readFileSync(path.join(docsDirectory, "package.json"), "utf8")).devDependencies,
)
  .filter((name) => name.startsWith("@usine/"))
  .map((name) => {
    const directory = realpathSync(path.join(docsDirectory, "node_modules", name));
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    return {
      name,
      directory,
      directoryName: path.basename(directory),
      description: String(manifest.description),
      subpaths: Object.entries(manifest.exports).map(([subpath, target]) => ({
        subpath: subpath.replace(/^\.\/?/, ""),
        declarationFile: path.join(directory, target.types),
      })),
    };
  });

/** TypeDoc names each entry module by its declaration file's path relative to this directory. */
export const packagesDirectory = path.dirname(documentedPackages[0]?.directory ?? docsDirectory);

export const entryPoints = documentedPackages.flatMap((documented) =>
  documented.subpaths.map(({ declarationFile }) => declarationFile),
);

/**
 * A TypeDoc plugin that shapes the API reference:
 *
 * - Entry modules are nested under one module per package, so each package gets a page listing
 *   its subpaths and each subpath a page at `<package>/<subpath>`. A package's root export (`.`)
 *   is the package module itself. Pages are titled with the import specifier.
 * - An Effect service class gets a `Service` property listing its operations.
 * - A class whose declaration file extends a hidden `X_base` constant shows the constant's type
 *   instead (`Schema.Class`), and its members stop citing `X_base` as their origin.
 * - Relative links in comments point at the file on GitHub.
 *
 * @param {import("typedoc").Application} app
 */
export function load(app) {
  /** @type {Map<DeclarationReflection, { name: string, typeName: string, isService: boolean }>} */
  const hiddenBases = new Map();
  /** @type {Array<{ module: DeclarationReflection, specifier: string }>} */
  const renames = [];

  app.converter.on(Converter.EVENT_CREATE_DECLARATION, (context, reflection) => {
    if (!reflection.kindOf(ReflectionKind.Class)) return;
    const base = hiddenBase(context.checker, context.getSymbolFromReflection(reflection));
    if (base === undefined) return;
    const operations = serviceOperations(context.checker, base.type);
    hiddenBases.set(reflection, {
      name: base.name,
      typeName: base.type.typeName.getText(),
      isService: operations !== undefined,
    });
    if (operations !== undefined) addServiceProperty(context, reflection, operations);
  });

  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, ({ project }) => {
    for (const [reflection, base] of hiddenBases) {
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
      // A service class's constructor takes `never`: services are provided by layers.
      if (base.isService) {
        for (const constructor of reflection.getChildrenByKind(ReflectionKind.Constructor)) {
          project.removeReflection(constructor);
        }
      }
    }
    hiddenBases.clear();
    renames.splice(0, renames.length, ...nestModulesByPackage(project));
  });

  // URLs are built from the short module names (`core`, `run`) before this event fires.
  app.renderer.on(RendererEvent.BEGIN, ({ project }) => {
    linkRepositoryFilesToGitHub(project);
    for (const { module, specifier } of renames) module.name = specifier;
  });
}

/** @param {string} declarationFile */
const moduleName = (declarationFile) =>
  path
    .relative(packagesDirectory, declarationFile)
    .split(path.sep)
    .join("/")
    .replace(/\.d\.ts$/, "");

/** @param {import("typedoc").ProjectReflection} project */
function nestModulesByPackage(project) {
  const renames = [];
  const modules = new Map((project.children ?? []).map((module) => [module.name, module]));
  /** @param {string} declarationFile */
  const entryModule = (declarationFile) => {
    const module = modules.get(moduleName(declarationFile));
    if (module === undefined) {
      throw new Error(`TypeDoc produced no module for ${declarationFile}`);
    }
    return module;
  };

  for (const documented of documentedPackages) {
    const root = documented.subpaths.find(({ subpath }) => subpath === "");
    const packageModule =
      root === undefined
        ? new DeclarationReflection(documented.name, ReflectionKind.Module, project)
        : entryModule(root.declarationFile);
    if (root === undefined) {
      project.registerReflection(packageModule, undefined, undefined);
      project.addChild(packageModule);
    }
    packageModule.name = documented.directoryName;
    packageModule.comment ??= new Comment([{ kind: "text", text: documented.description }]);
    renames.push({ module: packageModule, specifier: documented.name });

    for (const { subpath, declarationFile } of documented.subpaths) {
      if (subpath === "") continue;
      const module = entryModule(declarationFile);
      project.removeChild(module);
      module.parent = packageModule;
      module.name = subpath;
      packageModule.addChild(module);
      renames.push({ module, specifier: `${documented.name}/${subpath}` });
    }
  }
  return renames;
}

/**
 * The unexported constant a class extends in its declaration file. TypeScript emits one when the
 * source class extends an expression: `class Run extends Schema.Class<Run>("Run")({…})` becomes
 * `declare const Run_base: Schema.Class<…>` and `class Run extends Run_base`.
 *
 * @param {ts.TypeChecker} checker
 * @param {ts.Symbol | undefined} symbol
 */
function hiddenBase(checker, symbol) {
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
  return { name: base.name.text, type: base.type };
}

/**
 * The operations type of a `Context.ServiceClass<Self, Key, Operations>` base. The class only
 * exposes it through members declared in Effect, which TypeDoc leaves out as external.
 *
 * @param {ts.TypeChecker} checker
 * @param {ts.TypeReferenceNode} baseType
 */
function serviceOperations(checker, baseType) {
  let target = checker.getSymbolAtLocation(baseType.typeName);
  if (target !== undefined && target.flags & ts.SymbolFlags.Alias) {
    target = checker.getAliasedSymbol(target);
  }
  const isServiceClass =
    target?.name === "ServiceClass" &&
    (target.declarations ?? []).some((declaration) =>
      /[/\\]effect[/\\]dist[/\\]Context\.d\.ts$/.test(declaration.getSourceFile().fileName),
    );
  return isServiceClass ? baseType.typeArguments?.[2] : undefined;
}

/**
 * @param {import("typedoc").Context} context
 * @param {DeclarationReflection} reflection
 * @param {ts.TypeNode} operations
 */
function addServiceProperty(context, reflection, operations) {
  const classContext = context.withScope(reflection);
  const service = classContext.createDeclarationReflection(
    ReflectionKind.Property,
    undefined,
    undefined,
    "Service",
  );
  service.setFlag(ReflectionFlag.Readonly);
  service.comment = new Comment([
    { kind: "text", text: "The service's operations: what " },
    { kind: "code", text: `\`yield* ${reflection.name}\`` },
    { kind: "text", text: " returns." },
  ]);
  service.type = context.converter.convertType(classContext.withScope(service), operations);
  classContext.finalizeDeclarationReflection(service);
}

/**
 * Points relative links in comments (`../../../docs/adr/0027-….md`) at the file on GitHub.
 * Left alone, TypeDoc copies the linked file into the generated pages.
 *
 * @param {import("typedoc").ProjectReflection} project
 */
function linkRepositoryFilesToGitHub(project) {
  /** @param {import("typedoc").CommentDisplayPart[] | undefined} parts */
  const rewrite = (parts) => {
    for (const [index, part] of (parts ?? []).entries()) {
      if (part.kind !== "relative-link" || part.target === undefined) continue;
      const file = project.files.resolve(part.target, project);
      if (file === undefined || file instanceof Reflection) continue;
      const relative = path.relative(repositoryDirectory, file).split(path.sep).join("/");
      if (relative.startsWith("../")) continue;
      const anchor = part.targetAnchor === undefined ? "" : `#${part.targetAnchor}`;
      parts?.splice(index, 1, { kind: "text", text: `${repositoryFileUrl}${relative}${anchor}` });
    }
  };
  /** @param {import("typedoc").Comment | undefined} comment */
  const rewriteComment = (comment) => {
    rewrite(comment?.summary);
    for (const tag of comment?.blockTags ?? []) rewrite(tag.content);
  };

  rewriteComment(project.comment);
  rewrite(project.readme);
  for (const reflection of Object.values(project.reflections)) {
    rewriteComment(reflection.comment);
    if (reflection.isDeclaration()) rewrite(reflection.readme);
    if (reflection.isDocument()) rewrite(reflection.content);
  }
}

// @ts-check
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Comment, DeclarationReflection, Reflection, ReflectionKind } from "typedoc";

const docsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
 * The GitHub URL of the source file that a package's declaration file was built from, or
 * `undefined` when the declaration file isn't in a package's `dist/` folder.
 *
 * @param {string} declarationFile
 */
export function sourceFileUrl(declarationFile) {
  const match = /^(.*[/\\]packages[/\\][^/\\]+)[/\\]dist[/\\](.+)\.d\.ts$/.exec(declarationFile);
  if (match === null) return undefined;
  const sourceFile = path.join(match[1] ?? "", "src", `${match[2]}.ts`);
  if (!existsSync(sourceFile)) return undefined;
  return repositoryFileUrl + repositoryPath(sourceFile);
}

/** @param {string} file */
const repositoryPath = (file) => path.relative(repositoryDirectory, file).split(path.sep).join("/");

/** @param {string} declarationFile */
const moduleName = (declarationFile) =>
  path
    .relative(packagesDirectory, declarationFile)
    .split(path.sep)
    .join("/")
    .replace(/\.d\.ts$/, "");

/**
 * @typedef {object} ModuleTitle
 * @property {DeclarationReflection} module
 * @property {string} title The module's page title, which becomes its name once TypeDoc has built
 *   the page URLs from the short names (`core`, `run`).
 * @property {string} [declarationFile] The declaration file of a subpath module.
 */

/**
 * Nests the entry modules under one module per package. A package's root export (`.`) is the
 * package module itself. Returns the title of each module: its import specifier.
 *
 * @param {import("typedoc").ProjectReflection} project
 */
export function nestModulesByPackage(project) {
  /** @type {ModuleTitle[]} */
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
    renames.push({ module: packageModule, title: documented.name });

    for (const { subpath, declarationFile } of documented.subpaths) {
      if (subpath === "") continue;
      const module = entryModule(declarationFile);
      project.removeChild(module);
      module.parent = packageModule;
      module.name = subpath;
      packageModule.addChild(module);
      renames.push({ module, title: `${documented.name}/${subpath}`, declarationFile });
    }
  }
  return renames;
}

/** A subpath module with more members than this gets one page per source file. */
const largeModuleMembers = 40;

/**
 * Splits each large subpath module that re-exports members from other files: the members declared
 * in each other file move to a module of their own next to it, such as `operator/board` for the
 * members of `@usine/orchestrator/operator` declared in `board.ts`. The subpath module's comment
 * links the new pages. Returns the titles of the new modules. A package's root module is its
 * overview page and stays whole.
 *
 * The new modules are siblings rather than children of the subpath module: the module router puts
 * the page of a module nested two levels deep at the wrong path.
 *
 * @param {import("typedoc").ProjectReflection} project
 * @param {ModuleTitle[]} entryModules
 * @param {Map<import("typedoc").Reflection, string>} declarationFiles The file that declares each
 *   member of a module.
 */
export function splitLargeModules(project, entryModules, declarationFiles) {
  /** @type {ModuleTitle[]} */
  const titles = [];
  for (const { module, title, declarationFile } of entryModules) {
    const members = (module.children ?? []).filter((child) => !child.kindOf(ReflectionKind.Module));
    if (declarationFile === undefined || members.length <= largeModuleMembers) continue;
    /** @type {Map<string, DeclarationReflection[]>} */
    const byFile = new Map();
    for (const member of members) {
      const file = declarationFiles.get(member);
      if (file === undefined || file === declarationFile) continue;
      byFile.set(file, [...(byFile.get(file) ?? []), member]);
    }
    const container = module.parent;
    if (!(container instanceof DeclarationReflection) || byFile.size === 0) continue;
    const names = new Set((container.children ?? []).map((child) => child.name));
    /** @type {import("typedoc").CommentDisplayPart[]} */
    const links = [];
    for (const [file, moved] of byFile) {
      const fileName = path.basename(file, ".d.ts");
      const name = `${module.name}/${fileName}`;
      if (names.has(name)) continue;
      const split = new DeclarationReflection(name, ReflectionKind.Module, container);
      project.registerReflection(split, undefined, undefined);
      container.addChild(split);
      for (const member of moved) {
        module.removeChild(member);
        member.parent = split;
        split.addChild(member);
      }
      const sourceUrl = sourceFileUrl(file);
      split.comment = new Comment([
        { kind: "text", text: "Members of " },
        { kind: "code", text: `\`${title}\`` },
        { kind: "text", text: " declared in " },
        sourceUrl === undefined
          ? { kind: "code", text: `\`${fileName}.ts\`` }
          : { kind: "text", text: `[${sourceUrl.slice(repositoryFileUrl.length)}](${sourceUrl})` },
        { kind: "text", text: "." },
      ]);
      titles.push({ module: split, title: `${title} (${fileName}.ts)` });
      links.push(
        { kind: "text", text: links.length === 0 ? "" : ", " },
        { kind: "inline-tag", tag: "@link", text: `${fileName}.ts`, target: split },
      );
    }
    if (links.length === 0) continue;
    module.comment ??= new Comment();
    module.comment.summary.push(
      { kind: "text", text: "\n\nMembers declared in other files are on their own pages: " },
      ...links,
      { kind: "text", text: "." },
    );
  }
  return titles;
}

/**
 * Points relative links in comments (`../../../docs/adr/0027-….md`) at the file on GitHub.
 * Left alone, TypeDoc copies the linked file into the generated pages.
 *
 * @param {import("typedoc").ProjectReflection} project
 */
export function linkRepositoryFilesToGitHub(project) {
  /** @param {import("typedoc").CommentDisplayPart[] | undefined} parts */
  const rewrite = (parts) => {
    for (const [index, part] of (parts ?? []).entries()) {
      if (part.kind !== "relative-link" || part.target === undefined) continue;
      const file = project.files.resolve(part.target, project);
      if (file === undefined || file instanceof Reflection) continue;
      const relative = repositoryPath(file);
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

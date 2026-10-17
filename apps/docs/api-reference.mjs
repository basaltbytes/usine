// @ts-check
import { fileURLToPath } from "node:url";
import starlightTypeDoc from "starlight-typedoc";
import { documentedPackages, entryPoints, packagesDirectory } from "./typedoc/package-modules.mjs";

const output = "reference/api";

/**
 * Generates one page per package and one per public subpath under `reference/api/`, from the
 * declaration files the packages' builds emit.
 */
export const apiReference = starlightTypeDoc({
  entryPoints,
  tsconfig: fileURLToPath(new URL("tsconfig.typedoc.json", import.meta.url)),
  output,
  typeDoc: {
    plugin: [fileURLToPath(new URL("typedoc/plugin.mjs", import.meta.url))],
    name: "API",
    displayBasePath: packagesDirectory,
    router: "module",
    // The router numbers repeated anchors itself, and Astro's heading ids can number differently.
    useHTMLAnchors: true,
    entryFileName: "index",
    excludeExternals: true,
    excludePrivate: true,
    excludeInternal: true,
    disableSources: true,
    skipErrorChecking: true,
    parametersFormat: "table",
    classPropertiesFormat: "table",
  },
});

/**
 * One group per package, linking its page and its subpaths' pages. Members are headings on their
 * subpath's page, which keeps the sidebar small: Starlight renders all of it into every page.
 */
export const apiSidebarGroup = {
  label: "API",
  collapsed: true,
  items: documentedPackages.map((documented) => ({
    label: documented.name,
    collapsed: true,
    items: [
      { label: "Overview", slug: `${output}/${documented.directoryName}` },
      ...documented.subpaths
        .filter(({ subpath }) => subpath !== "")
        .toSorted((left, right) => left.subpath.localeCompare(right.subpath))
        .map(({ subpath }) => ({
          label: subpath,
          slug: `${output}/${documented.directoryName}/${subpath}`,
        })),
    ],
  })),
};

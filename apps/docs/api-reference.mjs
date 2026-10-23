// @ts-check
import { fileURLToPath } from "node:url";
import starlightTypeDoc from "starlight-typedoc";
import { documentedPackages, entryPoints, packagesDirectory } from "./typedoc/package-modules.mjs";

const output = "reference/api";

/** The starlight-typedoc plugin, which generates one page per package and per public subpath under `reference/api/` from the built declaration files. */
export const apiReference = starlightTypeDoc({
  entryPoints,
  tsconfig: fileURLToPath(new URL("tsconfig.typedoc.json", import.meta.url)),
  output,
  typeDoc: {
    plugin: [fileURLToPath(new URL("typedoc/plugin.mjs", import.meta.url))],
    name: "API",
    displayBasePath: packagesDirectory,
    router: "module",
    // The router numbers repeated anchors, and Astro's heading IDs can number them differently.
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

/** The API sidebar, with one group per package and its subpath pages; members are not listed. */
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

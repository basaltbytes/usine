import { Effect } from "effect";
// Test registration reads pages synchronously to declare one test for each diagram.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readdirSync, readFileSync } from "node:fs";
import { createMarkdownProcessor, type RemarkPlugin } from "@astrojs/markdown-remark";
import { expect, it } from "@effect/vitest";
import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";
import rehypePele from "../diagrams/rehype.mjs";

const renderer = await createMarkdownProcessor({
  rehypePlugins: [rehypePele],
  syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
});
const root = new URL("../src/content/docs/", import.meta.url);
const pages = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
  /\.mdx?$/.test(file),
);

for (const page of pages) {
  const fileURL = new URL(page, root);
  const source = readFileSync(fileURL, "utf8");
  if (!source.includes("mermaid")) continue;

  it.live(`renders every Mermaid fence on ${page} to an accessible SVG during the build`, () =>
    Effect.gen(function* () {
      let fences = 0;
      const countFences: RemarkPlugin = () => (tree) => {
        visit(tree, "code", (node) => {
          if (node.lang === "mermaid") fences++;
        });
      };
      const pageRenderer = yield* Effect.promise(() =>
        createMarkdownProcessor({
          remarkPlugins: [countFences],
          rehypePlugins: [rehypePele],
          syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
        }),
      );
      const { code } = yield* Effect.promise(() => pageRenderer.render(source, { fileURL }));
      const tree = fromHtml(code, { fragment: true });
      let diagrams = 0;
      visit(tree, "element", (node) => {
        if (
          node.tagName === "div" &&
          Array.isArray(node.properties.className) &&
          node.properties.className.includes("diagram")
        ) {
          diagrams++;
          expect(node.properties.tabIndex).toBe(0);
          expect(
            node.children.some((child) => child.type === "element" && child.tagName === "svg"),
          ).toBe(true);
        }
      });
      expect(diagrams).toBe(fences);
    }),
  );
}

it.live("fails rendering with the page, fence position, and Pele error for invalid Mermaid", () =>
  Effect.promise(() =>
    expect(
      renderer.render("# Broken\n\n```mermaid\nflowchart TB\n  A -->\n```", {
        fileURL: new URL("broken.md", root),
      }),
    ).rejects.toMatchObject({
      name: expect.stringContaining("broken.md:3"),
      message: expect.stringContaining("Pele:"),
    }),
  ),
);

it.live("keeps SVG references distinct when a page contains multiple diagrams", () =>
  Effect.gen(function* () {
    const source = "```mermaid\nflowchart TB\naccTitle: Example\nA --> B\n```";
    const { code } = yield* Effect.promise(() => renderer.render(`${source}\n\n${source}`));
    const tree = fromHtml(code, { fragment: true });
    const ids: string[] = [];
    const labels: string[] = [];
    visit(tree, "element", (node) => {
      if (node.properties.id !== undefined) ids.push(String(node.properties.id));
      if (Array.isArray(node.properties.ariaLabelledBy))
        labels.push(...node.properties.ariaLabelledBy.map(String));
    });
    expect(labels).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of labels) expect(ids).toContain(label);
  }),
);

// @ts-check
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import { PeleError, render } from "pele";
import { visit } from "unist-util-visit";

/** @type {import("@astrojs/markdown-remark").RehypePlugin} */
export default function rehypePele() {
  return (tree, file) => {
    let diagram = 0;
    visit(tree, "element", (node) => {
      if (node.tagName !== "pre") return;
      const code = node.children.find(
        (child) =>
          child.type === "element" &&
          child.tagName === "code" &&
          Array.isArray(child.properties.className) &&
          child.properties.className.includes("language-mermaid"),
      );
      if (!code) return;

      try {
        const { svg } = render(toString(code), {
          idPrefix: `diagram-${++diagram}`,
          responsive: false,
          maxWidth: 600,
        });
        node.tagName = "div";
        node.properties = {
          className: ["diagram"],
          tabIndex: 0,
          role: "region",
          ariaLabel: `Diagram ${diagram}. Scroll horizontally to view the full diagram.`,
        };
        node.children = fromHtml(svg, { fragment: true }).children.filter(
          (child) => child.type !== "doctype",
        );
      } catch (error) {
        if (!(error instanceof PeleError)) throw error;
        file.fail(`Pele: ${error.message}`, node.position);
      }
    });
  };
}

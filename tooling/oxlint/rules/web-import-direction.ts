import { defineRule, type ESTree } from "@oxlint/plugins";
import { dirname, relative, resolve, sep } from "node:path";

export const webImportDirectionRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep web routes, features, and shared modules in dependency order." },
    messages: {
      alias: "Use ~/ for imports outside the current folder.",
      direction:
        "Routes compose features. Features cannot import other features, and shared modules cannot import features or routes.",
    },
  },
  createOnce(context) {
    const check = (node: ESTree.Node) => {
      if (node.type !== "Literal" || typeof node.value !== "string") return;
      const filename = context.filename;
      const marker = `${sep}apps${sep}web${sep}src${sep}`;
      const start = filename.lastIndexOf(marker);
      if (start < 0) return;
      const root = filename.slice(0, start + marker.length);
      const source = relative(root, filename).split(sep);
      const specifier = node.value;
      if (specifier.startsWith("@/")) {
        context.report({ node, messageId: "alias" });
        return;
      }
      if (!specifier.startsWith("~/") && !specifier.startsWith(".")) return;
      const target = specifier.startsWith("~/")
        ? resolve(root, specifier.slice(2))
        : resolve(dirname(filename), specifier);
      if (specifier.startsWith(".") && dirname(target) !== dirname(filename)) {
        context.report({ node, messageId: "alias" });
      }
      if (/\.(?:test|spec)\.[jt]sx?$/u.test(filename)) return;
      const destination = relative(root, target).split(sep);
      const shared = ["components", "hooks", "lib"].includes(source[0] ?? "");
      const feature = source[0] === "features";
      if (
        ((shared || feature) && destination[0] === "routes") ||
        (shared && destination[0] === "features") ||
        (feature && destination[0] === "features" && source[1] !== destination[1])
      ) {
        context.report({ node, messageId: "direction" });
      }
    };
    return {
      ImportDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) check(node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      TSImportType(node) {
        check(node.source);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node.source);
      },
    };
  },
});

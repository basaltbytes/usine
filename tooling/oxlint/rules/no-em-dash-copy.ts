import { defineRule, type ESTree } from "@oxlint/plugins";
import { basename } from "node:path";

const EM_DASH = "—";

const inMarkup = (node: ESTree.Node): boolean => {
  for (let current: ESTree.Node | null = node.parent; current !== null; current = current.parent) {
    if (current.type === "JSXExpressionContainer" || current.type === "JSXAttribute") return true;
    if (current.type === "Program") return false;
  }
  return false;
};

export const noEmDashCopyRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow em dashes in web UI text: JSX text and strings, and `strings.ts` values.",
    },
    messages: {
      emDash:
        "Replace the em dash in UI text with a period, comma, colon, or parentheses. For an empty value, show `None` in muted text.",
    },
  },
  createOnce(context) {
    let copyFile = false;
    const check = (node: ESTree.Node, text: string | null) => {
      if (text?.includes(EM_DASH) && (copyFile || inMarkup(node))) {
        context.report({ node, messageId: "emDash" });
      }
    };
    return {
      before() {
        copyFile = basename(context.filename) === "strings.ts";
      },
      JSXText(node) {
        if (node.value.includes(EM_DASH)) context.report({ node, messageId: "emDash" });
      },
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
    };
  },
});

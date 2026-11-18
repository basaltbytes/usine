import { defineRule, type ESTree } from "@oxlint/plugins";

const GLOBALS = new Set(["globalThis", "self", "window"]);

const isResizeObserver = (callee: ESTree.Expression): boolean => {
  if (callee.type === "Identifier") return callee.name === "ResizeObserver";
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") return false;
  if (!GLOBALS.has(callee.object.name)) return false;
  return callee.computed
    ? callee.property.type === "Literal" && callee.property.value === "ResizeObserver"
    : callee.property.type === "Identifier" && callee.property.name === "ResizeObserver";
};

export const noRawResizeObserverRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow constructing ResizeObserver in the web UI; use observeResize.",
    },
    messages: {
      resizeObserver:
        "Use `observeResize` from `~/lib/observe-resize`. React commits state set in a raw ResizeObserver callback after the paint, so layout derived from the size is one frame late.",
    },
  },
  createOnce(context) {
    return {
      NewExpression(node) {
        if (isResizeObserver(node.callee)) {
          context.report({ node: node.callee, messageId: "resizeObserver" });
        }
      },
    };
  },
});

import { defineRule } from "@oxlint/plugins";
import { reactImport } from "../shared/react-import.ts";

export const noUnreasonedEffectRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require effects to document the external system they synchronize with." },
    messages: {
      unreasonedEffect:
        "Derive state during render or in an event handler. For external synchronization, add an oxlint-disable-next-line usine/no-unreasoned-effect comment with a -- reason naming that system.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const name = reactImport(context.sourceCode, node.callee);
        if (name === "useEffect" || name === "useLayoutEffect") {
          context.report({ node, messageId: "unreasonedEffect" });
        }
      },
    };
  },
});

import { defineRule } from "@oxlint/plugins";
import { reactImport } from "../shared/react-import.ts";

export const noManualMemoRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Let React Compiler memoize components and hooks." },
    messages: {
      manualMemo:
        "React Compiler handles memoization. Remove {{name}}; compiler exclusions must explain the compiler's reason in a disable comment.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const name = reactImport(context.sourceCode, node.callee);
        if (name === "useMemo" || name === "useCallback" || name === "memo") {
          context.report({ node, messageId: "manualMemo", data: { name } });
        }
      },
    };
  },
});

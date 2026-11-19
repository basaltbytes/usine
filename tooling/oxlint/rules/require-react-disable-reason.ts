import { defineRule } from "@oxlint/plugins";

import { invalidReactDisable } from "../shared/react-disable.ts";

export const requireReactDisableReasonRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require a reason and a next-line directive for React rule exclusions." },
    messages: {
      invalidDirective:
        "Use oxlint-disable-next-line with an explicit React rule name and -- <reason>. Name the external system for effects or the compiler exclusion for memoization.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!invalidReactDisable(comment.value)) continue;
          context.report({ loc: comment.loc, messageId: "invalidDirective" });
        }
      },
    };
  },
});

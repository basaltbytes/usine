import { defineRule } from "@oxlint/plugins";

const reactRules = new Set(["usine/no-manual-memo", "usine/no-unreasoned-effect"]);

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
          const directive =
            /^\s*(?:oxlint|eslint)-disable(-next-line|-line)?(?:\s|$)([\s\S]*)/u.exec(
              comment.value,
            );
          if (directive === null) continue;
          const [rules = "", ...reason] = (directive[2] ?? "").split(/(?:^|\s)--(?:\s|$)/u);
          const names = rules
            .trim()
            .split(/[\s,]+/u)
            .filter(Boolean);
          if (names.length > 0 && !names.some((name) => reactRules.has(name))) continue;
          if (directive[1] === "-next-line" && names.length > 0 && reason.join(" ").trim() !== "")
            continue;
          context.report({ loc: comment.loc, messageId: "invalidDirective" });
        }
      },
    };
  },
});

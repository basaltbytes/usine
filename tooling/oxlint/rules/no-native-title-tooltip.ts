import { defineRule } from "@oxlint/plugins";

// On these elements `title` names the embedded content for assistive technology.
const NAMED_BY_TITLE = new Set(["embed", "frame", "iframe", "math", "object"]);

export const noNativeTitleTooltipRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the native title tooltip on intrinsic elements in the web UI.",
    },
    messages: {
      title:
        "Replace the `title` attribute with `TextTooltip` from `~/components/text-tooltip`, or with `Tooltip` from `~/components/ui/tooltip`. If the element already shows the full text, remove `title`.",
    },
  },
  createOnce(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const element = node.name.name;
        if (!/^[a-z]/u.test(element) || NAMED_BY_TITLE.has(element)) return;
        for (const attribute of node.attributes) {
          if (attribute.type !== "JSXAttribute") continue;
          if (attribute.name.type === "JSXIdentifier" && attribute.name.name === "title") {
            context.report({ node: attribute, messageId: "title" });
          }
        }
      },
    };
  },
});

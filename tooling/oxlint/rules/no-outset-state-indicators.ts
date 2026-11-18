import { defineRule, type ESTree } from "@oxlint/plugins";

const COMPOSERS = new Set(["classNames", "clsx", "cn", "cva", "cx", "twMerge"]);
const STATE = /(?:^|\W)(?:focus(?:-visible|-within)?|selected|checked|pressed)(?=$|\W)/u;
const RING_WIDTH = /^ring(?:-(?:[1-9]\d*|\[(?:length:)?[\d.]+[a-z]*\]|\(length:[^)]+\)))?$/u;
const POSITIVE_OFFSET = /^(?:outline-offset-(?!0$)|\[outline-offset:)/u;

type ClassToken = {
  readonly variants: ReadonlyArray<string>;
  readonly utility: string;
  readonly text: string;
};

const parse = (text: string): ClassToken => {
  const variants: Array<string> = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "[" || character === "(") depth++;
    else if (character === "]" || character === ")") depth--;
    else if (character === ":" && depth === 0) {
      variants.push(text.slice(start, index));
      start = index + 1;
    }
  }
  return { variants, utility: text.slice(start).replace(/^!|!$/gu, ""), text };
};

const tokens = (text: string): Array<ClassToken> => text.split(/\s+/u).filter(Boolean).map(parse);

const isComposer = (node: ESTree.Node): node is ESTree.CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  COMPOSERS.has(node.callee.name);

// Collects the classes every branch of a composer call applies, skipping conditional ones.
const collect = (node: ESTree.Node, out: Array<string>): void => {
  if (node.type === "Literal") {
    if (typeof node.value === "string") out.push(node.value);
    return;
  }
  if (node.type === "TemplateLiteral") {
    for (const quasi of node.quasis) out.push(quasi.value.cooked ?? "");
    return;
  }
  if (node.type === "ArrayExpression") {
    for (const element of node.elements) if (element !== null) collect(element, out);
    return;
  }
  if (isComposer(node)) for (const argument of node.arguments) collect(argument, out);
};

const surrounding = (node: ESTree.Node): Array<ClassToken> => {
  const strings: Array<string> = [];
  for (let current: ESTree.Node | null = node.parent; current !== null; current = current.parent) {
    if (/Statement$|Declaration$|^JSXAttribute$/u.test(current.type)) break;
    if (isComposer(current)) collect(current, strings);
  }
  return tokens(strings.join(" "));
};

const covers = (companion: ClassToken, indicator: ClassToken): boolean =>
  companion.variants.every((variant) => indicator.variants.includes(variant));

export const noOutsetStateIndicatorsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep focus and selection indicators inside their element, where an ancestor with overflow cannot clip them.",
    },
    messages: {
      ring: "`{{token}}` draws a ring outside the element, where an ancestor with overflow can clip it. Add `ring-inset` under the same variants, such as `focus-visible:ring-inset`.",
      offset:
        "`{{token}}` moves the outline outside the element, where an ancestor with overflow can clip it. Remove the offset, or use a negative one such as `-outline-offset-2`.",
    },
  },
  createOnce(context) {
    const check = (node: ESTree.Node, text: string) => {
      const own = tokens(text);
      let scope: Array<ClassToken> | null = null;
      for (const token of own) {
        if (POSITIVE_OFFSET.test(token.utility)) {
          context.report({ node, messageId: "offset", data: { token: token.text } });
          continue;
        }
        if (!RING_WIDTH.test(token.utility) || !STATE.test(token.variants.join(":"))) continue;
        scope ??= [...own, ...surrounding(node)];
        const inset = scope.some((other) => other.utility === "ring-inset" && covers(other, token));
        if (!inset) context.report({ node, messageId: "ring", data: { token: token.text } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((quasi) => quasi.value.cooked ?? "").join(" "));
      },
    };
  },
});

import type { ReactNode } from "react";
import { Markdown } from "~/components/markdown";

/** Subset of a Markdown syntax tree node used by the interpolation marks. */
interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  children?: Array<MarkdownNode>;
  readonly data?: { readonly hName: string };
}

const INTERPOLATION = /\{\{([\s\S]*?)\}\}/gu;

/** Returns the trimmed text between each `{{` and `}}` in `template`. */
export const interpolations = (template: string): ReadonlyArray<string> =>
  [...template.matchAll(INTERPOLATION)].map(([, expression = ""]) => expression.trim());

const splitText = (node: MarkdownNode): ReadonlyArray<MarkdownNode> => {
  const value = node.value ?? "";
  const parts: Array<MarkdownNode> = [];
  let last = 0;
  for (const match of value.matchAll(INTERPOLATION)) {
    if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
    parts.push({ type: "inlineCode", value: (match[1] ?? "").trim(), data: { hName: "mark" } });
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return [node];
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
};

const markInterpolations = (node: MarkdownNode): void => {
  if (node.children === undefined) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text") return splitText(child);
    markInterpolations(child);
    return [child];
  });
};

// Only text nodes are marked; code spans and code blocks are left as written.
const remarkInterpolations = () => markInterpolations;

const Interpolation = ({ children }: { readonly children?: ReactNode }) => (
  <mark
    className="bg-transparent p-0 text-inherit"
    title="Filled in from the item when a run opens"
  >
    <code className="bg-transparent [font-variant-ligatures:none] ring-1 ring-input ring-inset [box-decoration-break:clone]">
      <span className="text-muted-foreground">{"{{\u00a0"}</span>
      {children}
      <span className="text-muted-foreground">{"\u00a0}}"}</span>
    </code>
  </mark>
);

/** Renders a Loop's prompt template as Markdown with each `{{ }}` expression in prose outlined. */
export const PromptMarkdown = ({ template }: { readonly template: string }) => (
  <Markdown
    className="max-w-[72ch] text-md"
    remarkPlugins={[remarkInterpolations]}
    components={{ mark: Interpolation }}
  >
    {template}
  </Markdown>
);

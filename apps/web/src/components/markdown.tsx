import type { ComponentProps } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

type RemarkPlugins = NonNullable<Options["remarkPlugins"]>;

const REMARK_PLUGINS: RemarkPlugins = [remarkGfm];

const MarkdownLink = ({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => (
  <a {...props} target="_blank" rel="noreferrer" />
);

const COMPONENTS: Components = { a: MarkdownLink };

/** Renders agent and operator prose from Markdown, styled by shadcn/typeset (src/typeset.css).
 * `remarkPlugins` and `components` add to the defaults, for prose with marks of its own. */
export const Markdown = ({
  children,
  className,
  remarkPlugins = [],
  components = {},
}: {
  readonly children: string;
  readonly className?: string;
  readonly remarkPlugins?: RemarkPlugins;
  readonly components?: Components;
}) => (
  <div className={cn("typeset typeset-chat", className)}>
    <ReactMarkdown
      remarkPlugins={[...REMARK_PLUGINS, ...remarkPlugins]}
      components={{ ...COMPONENTS, ...components }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

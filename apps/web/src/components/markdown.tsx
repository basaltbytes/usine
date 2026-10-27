import type { ComponentProps } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";

type RemarkPlugins = NonNullable<Options["remarkPlugins"]>;

const REMARK_PLUGINS: RemarkPlugins = [remarkGfm];

type MarkdownLinkProps = ComponentProps<"a"> & { node?: unknown };

const MarkdownLink = ({ node: _node, ...props }: MarkdownLinkProps) => (
  <a {...props} target="_blank" rel="noreferrer" />
);

const COMPONENTS: Components = { a: MarkdownLink };

type MarkdownProps = {
  readonly children: string;
  readonly className?: string;
  readonly remarkPlugins?: RemarkPlugins;
  readonly components?: Components;
};

/** Renders Markdown with the styles in src/typeset.css; `remarkPlugins` and `components` are merged with the defaults. */
export const Markdown = ({
  children,
  className,
  remarkPlugins = [],
  components = {},
}: MarkdownProps) => (
  <div className={cn("typeset typeset-chat", className)}>
    <ReactMarkdown
      remarkPlugins={[...REMARK_PLUGINS, ...remarkPlugins]}
      components={{ ...COMPONENTS, ...components }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

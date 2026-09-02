import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const REMARK_PLUGINS = [remarkGfm];

const MarkdownLink = ({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) => (
  <a {...props} target="_blank" rel="noreferrer" />
);

const COMPONENTS: Components = { a: MarkdownLink };

/** Agent and operator prose, rendered from Markdown and styled by shadcn/typeset (src/typeset.css). */
export const Markdown = ({
  children,
  className,
}: {
  readonly children: string;
  readonly className?: string;
}) => (
  <div className={cn("typeset typeset-chat", className)}>
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  </div>
);

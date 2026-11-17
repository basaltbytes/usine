import { Schema } from "effect";
import { type ComponentProps, createContext, use } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "~/lib/utils";

type RemarkPlugins = NonNullable<Options["remarkPlugins"]>;

const REMARK_PLUGINS: RemarkPlugins = [remarkGfm];

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Returns `url` if it is absolute with an `http`, `https`, or `mailto` scheme. */
const linkTarget = (url: string | undefined) =>
  url !== undefined && URL.canParse(url) && LINK_SCHEMES.has(new URL(url).protocol)
    ? url
    : undefined;

const InsideLink = createContext(false);

type MarkdownLinkProps = ComponentProps<"a"> & { node?: unknown };

const MarkdownLink = ({ node: _node, href, children, ...props }: MarkdownLinkProps) => {
  const target = linkTarget(href);
  return target === undefined ? (
    <span>{children}</span>
  ) : (
    <InsideLink value={true}>
      <a {...props} href={target} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    </InsideLink>
  );
};

type MarkdownImageProps = ComponentProps<"img"> & { node?: unknown };

// Markdown here comes from agents, tools, and issues, and an image would load its URL without a click.
const MarkdownImage = ({ src, alt }: MarkdownImageProps) => {
  const insideLink = use(InsideLink);
  const target = Schema.is(Schema.String)(src) ? linkTarget(src) : undefined;
  const label = alt !== undefined && alt !== "" ? alt : (target ?? "");
  return target === undefined || insideLink ? (
    <span>{label}</span>
  ) : (
    <a href={target} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
};

const COMPONENTS: Components = { a: MarkdownLink, img: MarkdownImage };

type MarkdownProps = {
  readonly children: string;
  readonly className?: string;
  readonly remarkPlugins?: RemarkPlugins;
  readonly components?: Components;
};

/**
 * Renders Markdown with the styles in src/typeset.css; `remarkPlugins` and `components` are merged with the defaults.
 * Links open in a new tab and only for `http`, `https`, and `mailto` URLs; images render as links; raw HTML renders as text.
 */
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

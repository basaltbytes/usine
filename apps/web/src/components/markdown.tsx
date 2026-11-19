import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { Schema } from "effect";
import { type ComponentProps, createContext, use } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Reference } from "~/components/references/reference";
import { ReferenceScopeContext } from "~/components/references/scope";
import { REFERENCE_ELEMENT, remarkReferences } from "~/lib/references/syntax";
import { cn } from "~/lib/utils";

type RemarkPlugins = NonNullable<Options["remarkPlugins"]>;

const REMARK_PLUGINS: RemarkPlugins = [remarkGfm];

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Returns `url` if it is absolute with an `http`, `https`, or `mailto` scheme. */
const linkTarget = (url: string | undefined) =>
  url !== undefined && URL.canParse(url) && LINK_SCHEMES.has(new URL(url).protocol)
    ? url
    : undefined;

/**
 * Returns the path, query, and fragment of `url` if it opens a page of the app: a path from the
 * root, or a URL on the page's origin, that one of `router`'s routes matches whole.
 */
const appHref = (url: string | undefined, router: AnyRouter | null): string | undefined => {
  if (url === undefined || router === null) return undefined;
  const { origin } = window.location;
  const absolute = URL.canParse(url);
  if (!absolute && !(url.startsWith("/") && !url.startsWith("//"))) return undefined;
  const target = new URL(url, origin);
  if (target.origin !== origin || (absolute && !["http:", "https:"].includes(target.protocol)))
    return undefined;
  const [, params, route] = router.getMatchedRoutes(target.pathname);
  return route === undefined || params["**"] !== undefined
    ? undefined
    : `${target.pathname}${target.search}${target.hash}`;
};

const InsideLink = createContext(false);

type MarkdownLinkProps = ComponentProps<"a"> & { node?: unknown };

const MarkdownLink = ({ node: _node, href, children, ...props }: MarkdownLinkProps) => {
  // Markdown outside a router, as in a component test, links no page of the app.
  const router: AnyRouter | null = useRouter({ warn: false });
  const page = appHref(href, router);
  const target = linkTarget(href);
  return page !== undefined && router !== null ? (
    <InsideLink value={true}>
      <a
        {...props}
        href={router.history.createHref(page)}
        onClick={(event) => {
          // A modified or middle click opens the page in a new tab or window, as for any link.
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          void router.navigate({ href: page });
        }}
      >
        {children}
      </a>
    </InsideLink>
  ) : target === undefined ? (
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

// Only `remarkReferences` makes reference elements, so they render only inside a reference scope.
const COMPONENTS: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  [REFERENCE_ELEMENT]: Reference,
};

type MarkdownProps = {
  readonly children: string;
  readonly className?: string;
  readonly remarkPlugins?: RemarkPlugins;
  readonly components?: Components;
};

/**
 * Renders Markdown with the styles in src/typeset.css; `remarkPlugins` and `components` are merged with the defaults.
 * A path that a route of the app matches links to that page; other links open in a new tab and only for `http`,
 * `https`, and `mailto` URLs. Images render as links, and raw HTML renders as text. Inside a `ReferenceScopeContext`,
 * the tasks, runs, source lines, and names that the text writes link to what they name.
 */
export const Markdown = ({
  children,
  className,
  remarkPlugins = [],
  components = {},
}: MarkdownProps) => {
  const scoped = use(ReferenceScopeContext) !== undefined;
  return (
    <div className={cn("typeset typeset-chat", className)}>
      <ReactMarkdown
        remarkPlugins={[...REMARK_PLUGINS, ...(scoped ? [remarkReferences] : []), ...remarkPlugins]}
        components={{ ...COMPONENTS, ...components }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
};

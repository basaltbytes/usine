// Adapted from Vercel AI Elements. See README.md and LICENSE in this folder.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";

import { cn } from "@/lib/utils";

import { CopyButton } from "./copy-button";

/** Languages represented by the command, file and patch tools. */
export type CodeLanguage = "bash" | "text" | "diff" | "typescript" | "json";

const CodeBlockContext = createContext("");

interface CodeToken {
  readonly content: string;
  readonly style: CSSProperties;
}

const languages = {
  bash: () => import("shiki/langs/bash.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
};

const highlight = async (
  code: string,
  language: Exclude<CodeLanguage, "text">,
): Promise<readonly (readonly CodeToken[])[]> => {
  const [core, engine, grammar] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    languages[language](),
  ]);
  const theme = core.createCssVariablesTheme({
    name: "usine",
    variableDefaults: {
      foreground: "var(--foreground)",
      background: "transparent",
      "token-constant": "var(--needs-you)",
      "token-string": "var(--run-succeeded)",
      "token-comment": "var(--muted-foreground)",
      "token-keyword": "var(--primary)",
      "token-parameter": "var(--foreground)",
      "token-function": "var(--run-active)",
      "token-string-expression": "var(--run-succeeded)",
      "token-punctuation": "var(--muted-foreground)",
      "token-link": "var(--run-active)",
      "token-inserted": "var(--run-succeeded)",
      "token-deleted": "var(--destructive)",
      "token-changed": "var(--needs-you)",
    },
  });
  const highlighter = await core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(),
    themes: [theme],
    langs: [grammar.default],
  });
  try {
    return highlighter.codeToTokens(code, { lang: language, theme: "usine" }).tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        style: {
          color: token.color,
          backgroundColor: token.bgColor,
          fontStyle: (token.fontStyle ?? 0) & 1 ? "italic" : undefined,
          fontWeight: (token.fontStyle ?? 0) & 2 ? "bold" : undefined,
          textDecoration: (token.fontStyle ?? 0) & 4 ? "underline" : undefined,
        },
      })),
    );
  } finally {
    highlighter.dispose();
  }
};

const CodeBlockContent = ({
  code,
  language,
  showLineNumbers,
  wrap,
}: {
  code: string;
  language: CodeLanguage;
  showLineNumbers: boolean;
  wrap: boolean;
}) => {
  const [result, setResult] = useState<
    | ({ readonly code: string; readonly language: CodeLanguage } & (
        | { readonly _tag: "Highlighted"; readonly lines: readonly (readonly CodeToken[])[] }
        | { readonly _tag: "Failed" }
      ))
    | null
  >(null);

  useEffect(() => {
    if (language === "text") return;
    let cancelled = false;
    void highlight(code, language).then(
      (lines) => {
        if (!cancelled) setResult({ _tag: "Highlighted", code, language, lines });
      },
      () => {
        if (!cancelled) setResult({ _tag: "Failed", code, language });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  // Exact identity prevents an old async result from replacing newer source text.
  const lines =
    result?.code === code && result.language === language && result._tag === "Highlighted"
      ? result.lines
      : code.split("\n").map((content) => [{ content, style: {} }]);
  const failed = result?.code === code && result.language === language && result._tag === "Failed";

  return (
    <>
      <div className="max-h-96 overflow-auto">
        <pre
          className={cn(
            "m-0 p-3 font-mono text-xs/relaxed",
            wrap && "whitespace-pre-wrap wrap-anywhere",
          )}
        >
          <code>
            {lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {showLineNumbers && (
                  <span
                    aria-hidden="true"
                    className="mr-4 inline-block w-8 select-none text-right text-muted-foreground"
                  >
                    {lineIndex + 1}
                  </span>
                )}
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={token.style}>
                    {token.content}
                  </span>
                ))}
                {lineIndex < lines.length - 1 ? "\n" : null}
              </span>
            ))}
          </code>
        </pre>
      </div>
      {failed && (
        <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">
          Syntax highlighting unavailable. Original text is shown.
        </p>
      )}
    </>
  );
};

/**
 * A copyable source panel; highlighting loads only when the panel mounts. With
 * `wrap`, long lines wrap anywhere instead of scrolling sideways, so a one-line
 * command shows whole.
 */
export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  wrap = false,
  children,
  className,
  ...props
}: ComponentProps<"div"> & {
  code: string;
  language: CodeLanguage;
  showLineNumbers?: boolean;
  wrap?: boolean;
}) => (
  <CodeBlockContext.Provider value={code}>
    <div
      className={cn(
        "not-prose min-w-0 overflow-hidden rounded-md border bg-background text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <CodeBlockContent
        code={code}
        language={language}
        showLineNumbers={showLineNumbers}
        wrap={wrap}
      />
    </div>
  </CodeBlockContext.Provider>
);

/** The panel's filename or command label and copy action. */
export const CodeBlockHeader = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground",
      className,
    )}
    {...props}
  />
);
/** A source panel's title. */
export const CodeBlockTitle = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex min-w-0 items-center gap-2", className)} {...props} />
);
/** A source panel's filename, kept as literal text. */
export const CodeBlockFilename = ({ className, ...props }: ComponentProps<"span">) => (
  <span className={cn("truncate font-mono", className)} {...props} />
);
/** Actions available for the source shown by the panel. */
export const CodeBlockActions = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex shrink-0 items-center gap-2", className)} {...props} />
);
/** Copies the original source without rendered line numbers or highlighting. */
export const CodeBlockCopyButton = (
  props: Omit<ComponentProps<typeof CopyButton>, "value" | "label">,
) => <CopyButton value={useContext(CodeBlockContext)} label="Copy code" {...props} />;

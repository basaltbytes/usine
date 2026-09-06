// Adapted from Vercel AI Elements. See README.md and LICENSE in this folder.
import { TerminalIcon } from "@phosphor-icons/react";
import Ansi from "ansi-to-react-component";
import { createContext, useContext, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { CopyButton } from "./copy-button";

const TerminalContext = createContext("");

/** The command output panel's label and copy action. */
export const TerminalHeader = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2",
      className,
    )}
    {...props}
  />
);
/** The label for persisted command output. */
export const TerminalTitle = ({ children, className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("flex min-w-0 items-center gap-2 text-xs text-muted-foreground", className)}
    {...props}
  >
    <TerminalIcon className="size-3.5 shrink-0" />
    {children ?? "Output"}
  </div>
);
/** Actions available for the command output. */
export const TerminalActions = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("flex shrink-0 items-center gap-2", className)} {...props} />
);
/** Copies the original output, including any escape sequences. */
export const TerminalCopyButton = (
  props: Omit<ComponentProps<typeof CopyButton>, "value" | "label">,
) => <CopyButton value={useContext(TerminalContext)} label="Copy output" {...props} />;
/** ANSI-aware output without a competing live-scroll controller. */
export const TerminalContent = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("max-h-96 overflow-auto p-3 font-mono text-xs/relaxed", className)} {...props}>
    <pre className="m-0 whitespace-pre-wrap break-words">
      <Ansi>{useContext(TerminalContext)}</Ansi>
    </pre>
  </div>
);

/** Read-only command output; compose children to customize its header. */
export const Terminal = ({
  output,
  title = "Terminal",
  children,
  className,
  ...props
}: ComponentProps<"div"> & { output: string }) => (
  <TerminalContext.Provider value={output}>
    <div
      className={cn(
        "not-prose min-w-0 overflow-hidden rounded-md border bg-background text-foreground",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <TerminalHeader>
            <TerminalTitle>{title}</TerminalTitle>
            <TerminalActions>
              <TerminalCopyButton />
            </TerminalActions>
          </TerminalHeader>
          <TerminalContent />
        </>
      )}
    </div>
  </TerminalContext.Provider>
);

// Adapted from Vercel AI Elements. See README.md and LICENSE in this folder.
import {
  CaretDownIcon,
  CircleNotchIcon,
  StopCircleIcon,
  WrenchIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";

type ToolStatus = "Running" | "Completed" | "Error" | "Stopped";

const statusIcons = {
  Running: <CircleNotchIcon className="motion-safe:animate-spin text-run-active" />,
  Error: <XCircleIcon className="text-destructive" />,
  Stopped: <StopCircleIcon className="text-muted-foreground" />,
} satisfies Record<Exclude<ToolStatus, "Completed">, ReactNode>;

/** One expandable invocation, retaining its identity as its status changes. */
export const Tool = ({ className, ...props }: ComponentProps<typeof Collapsible>) => (
  <Collapsible className={cn("group/tool not-prose w-full min-w-0", className)} {...props} />
);

/** The invocation's name, current status and optional command/path preview. */
export const ToolHeader = ({
  title,
  status,
  icon,
  description,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof CollapsibleTrigger>, "title"> & {
  title: string;
  status: ToolStatus;
  icon?: ReactNode;
  description?: ReactNode;
}) => (
  <CollapsibleTrigger
    className={cn(
      "group/tool-trigger -mx-2 flex min-h-11 w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[panel-open]:bg-muted/30",
      className,
    )}
    {...props}
  >
    <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">
      {icon ?? <WrenchIcon />}
    </span>
    <span className="min-w-0 flex-1 space-y-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium wrap-anywhere">{title}</span>
        {status !== "Completed" && (
          <Badge variant="secondary" className="gap-1">
            {statusIcons[status]}
            {status}
          </Badge>
        )}
        {children}
      </span>
      {description && (
        <span className="block truncate font-mono text-xs text-muted-foreground group-data-[panel-open]/tool-trigger:whitespace-normal group-data-[panel-open]/tool-trigger:wrap-anywhere">
          {description}
        </span>
      )}
    </span>
    <CaretDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/tool-trigger:rotate-180" />
  </CollapsibleTrigger>
);

/** The invocation's expanded input and result panels. */
export const ToolContent = ({ className, ...props }: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent
    className={cn("min-w-0 space-y-3 pt-2 pb-2 pl-5.5 outline-none", className)}
    {...props}
  />
);

/** A named result section; callers supply content appropriate to the tool. */
export const ToolOutput = ({
  className,
  title = "Result",
  children,
  ...props
}: ComponentProps<"div">) => (
  <div className={cn("min-w-0 space-y-2", className)} {...props}>
    <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
    {children}
  </div>
);

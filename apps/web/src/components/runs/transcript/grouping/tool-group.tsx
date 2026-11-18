import { CaretRightIcon } from "@phosphor-icons/react";
import { Option } from "effect";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { UsineMark } from "~/components/usine-mark";
import { burstSummary, callActivityLabel } from "~/lib/runs/transcript/grouping/summary";
import type { ToolCall } from "~/lib/runs/transcript/model";
import { presentTool } from "~/lib/runs/transcript/tool/presentation";
import { durationLabel } from "~/lib/strings";
import { cn } from "~/lib/utils";
import { TextTooltip } from "~/components/text-tooltip";

type CurrentCallProps = { readonly call: ToolCall };

const CurrentCall = ({ call }: CurrentCallProps) => {
  const view = presentTool(call);
  return (
    <p aria-live="off" className="flex min-w-0 items-baseline gap-2 pb-1 pl-5.5 text-xs">
      <span className="shrink-0 text-run-active">{callActivityLabel(view)}</span>
      <TextTooltip text={view.subject} repeats>
        <span className="min-w-0 truncate font-mono text-muted-foreground">{view.subject}</span>
      </TextTooltip>
    </p>
  );
};

type ToolGroupProps = Omit<ComponentProps<typeof Collapsible>, "children"> & {
  readonly tools: ReadonlyArray<ToolCall>;
  /** The milliseconds from the first call's start to the last result, when known. */
  readonly span?: Option.Option<number>;
  /**
   * The running call to show under the line, in place of the running count. A surface without
   * its own current activity passes it.
   */
  readonly current?: ToolCall | undefined;
  /** The rows of the calls, shown while the group is open. */
  readonly children: ReactNode;
};

/**
 * Renders consecutive tool calls as one line that says what ran, counts failed and running calls,
 * and opens to `children`. The run reader and conversations both render tool calls with it.
 */
export const ToolGroup = ({
  tools,
  span = Option.none(),
  current,
  children,
  className,
  ...props
}: ToolGroupProps) => {
  const failed = tools.filter((tool) => tool.state._tag === "Error").length;
  const running =
    current === undefined ? tools.filter((tool) => tool.state._tag === "Running").length : 0;
  return (
    <Collapsible className={cn("min-w-0", className)} {...props}>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="-mx-2 h-auto min-h-7 w-[calc(100%+1rem)] justify-start gap-2 px-2 py-1 text-left text-xs font-normal whitespace-normal text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:hover:bg-muted/70 data-[panel-open]:[&>svg]:rotate-90"
          />
        }
      >
        <CaretRightIcon aria-hidden="true" className="shrink-0 transition-transform" />
        <span className="min-w-0">
          {burstSummary({ tools })}
          {failed > 0 && <span className="text-destructive">, {failed} failed</span>}
          {running > 0 && (
            <span className="text-run-active">
              , <UsineMark running className="mr-1 inline-block size-3 align-middle" />
              {running} running
            </span>
          )}
          {Option.match(span, {
            onNone: () => null,
            onSome: (milliseconds) => (
              <>
                {" · "}
                <span className="font-mono tabular-nums">{durationLabel(milliseconds)}</span>
              </>
            ),
          })}
          <span className="sr-only">
            {" "}
            · {tools.length} {tools.length === 1 ? "tool call" : "tool calls"}
          </span>
        </span>
      </CollapsibleTrigger>
      {current !== undefined && <CurrentCall call={current} />}
      <CollapsibleContent className="collapsible-motion -mx-2 space-y-1 px-2 pt-1 pb-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};

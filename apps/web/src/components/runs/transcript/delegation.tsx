import { CaretRightIcon } from "@phosphor-icons/react";
import { Option } from "effect";
import { Tool, ToolContent } from "~/components/ai-elements/tool";
import { burstSpan } from "~/components/runs/transcript/grouping/burst";
import { Gutter } from "~/components/runs/transcript/gutter";
import { ReaderLine } from "~/components/runs/transcript/reader-line";
import { ToolDetails, useToolDisclosure } from "~/components/runs/transcript/tool/tool";
import { Button } from "~/components/ui/button";
import { CollapsibleTrigger } from "~/components/ui/collapsible";
import type { DelegationRow } from "~/lib/runs/transcript/document/model";
import { presentTool } from "~/lib/runs/transcript/tool/presentation";
import { durationLabel } from "~/lib/strings";

type DelegationProps = {
  readonly row: DelegationRow;
  readonly speaker: string | null;
};

export const Delegation = ({ row, speaker }: DelegationProps) => {
  const disclosure = useToolDisclosure(row.tool.key);
  const view = presentTool(row.tool);
  const given = view.input.find((section) => section._tag === "Text" && section.label === "Task");
  const task = given?._tag === "Text" ? given.text : view.subject;
  const span = burstSpan([row.tool]);
  const state = row.tool.state._tag;
  return (
    <ReaderLine gutter={<Gutter receivedAt={row.tool.receivedAt} speaker={speaker} />}>
      <Tool data-transcript-id={row.tool.key} {...disclosure}>
        <p className="line-clamp-2 text-md wrap-anywhere text-muted-foreground">{task}</p>
        <CollapsibleTrigger
          aria-label={`Delegated task: ${view.subject} · ${state === "Finished" ? "Completed" : state}`}
          render={
            <Button
              variant="ghost"
              size="sm"
              className="-mx-2 h-auto min-h-7 w-[calc(100%+1rem)] justify-start gap-2 px-2 py-1 text-left text-xs font-normal whitespace-normal text-muted-foreground hover:text-foreground aria-expanded:bg-transparent aria-expanded:hover:bg-muted/70 data-[panel-open]:[&>svg]:rotate-90"
            />
          }
        >
          <CaretRightIcon aria-hidden="true" className="shrink-0 transition-transform" />
          <span>
            Delegated a task
            {state === "Running" && <span className="text-run-active">, running</span>}
            {state === "Error" && <span className="text-destructive">, failed</span>}
            {Option.match(span, {
              onNone: () => null,
              onSome: (milliseconds) => (
                <>
                  {" · "}
                  <span className="font-mono tabular-nums">{durationLabel(milliseconds)}</span>
                </>
              ),
            })}
          </span>
        </CollapsibleTrigger>
        <ToolContent className="collapsible-motion pl-0">
          <ToolDetails entry={row.tool} view={view} />
        </ToolContent>
      </Tool>
    </ReaderLine>
  );
};

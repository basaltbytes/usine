import {
  CaretRightIcon,
  FilePlusIcon,
  FileTextIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TerminalWindowIcon,
  UsersIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { Option } from "effect";
import { Tool, ToolContent, ToolHeader, ToolOutput } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useMessageScroller } from "@/components/ui/message-scroller";
import type { TranscriptTool } from "../model.ts";
import { ToolSections } from "./content.tsx";
import { presentTool } from "./presentation.ts";
import { useTranscriptDisclosure } from "../grouping/disclosure.tsx";

const icons = {
  command: TerminalWindowIcon,
  read: FileTextIcon,
  edit: PencilSimpleIcon,
  write: FilePlusIcon,
  search: MagnifyingGlassIcon,
  agent: UsersIcon,
  tool: WrenchIcon,
};

/** One durable tool call, displayed by its purpose with full payloads available on request. */
export const TranscriptToolRow = ({ entry }: { readonly entry: TranscriptTool }) => {
  const { scrollToMessage } = useMessageScroller();
  const disclosure = useTranscriptDisclosure();
  const view = presentTool(entry);
  const Icon = icons[view.category];
  const state = entry.state;
  const status = state._tag === "Finished" ? "Completed" : state._tag;
  const patchFirst =
    view.category === "edit" &&
    view.output.some((section) => section._tag === "Code" && section.language === "diff");
  const input = (
    <>
      <ToolSections sections={view.input} category={view.category} />
      {Option.isNone(entry.start) && (
        <p className="text-muted-foreground">Load earlier history to see this call’s input.</p>
      )}
    </>
  );
  const duration = Option.match(entry.start, {
    onNone: () => "",
    onSome: ({ receivedAt }) => {
      if (state._tag !== "Finished" && state._tag !== "Error") return "";
      const elapsed = Date.parse(state.receivedAt) - Date.parse(receivedAt);
      if (!Number.isFinite(elapsed) || elapsed < 0) return "";
      return elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;
    },
  });
  return (
    <Tool
      data-transcript-id={entry.key}
      open={disclosure.state.get(entry.key)?.open === true}
      className="motion-safe:animate-in motion-safe:fade-in"
      onOpenChange={(open) => {
        // Inspecting a tool suspends following the bottom before its content grows.
        if (open) scrollToMessage(entry.key, { align: "nearest", behavior: "instant" });
        disclosure.change({ _tag: "Item", key: entry.key, open });
      }}
    >
      <ToolHeader
        title={view.title}
        status={status}
        icon={<Icon aria-hidden="true" />}
        description={view.subject}
        aria-label={`${view.title}: ${view.subject} · ${status}`}
      >
        {duration !== "" && (
          <span className="font-mono text-xs text-muted-foreground">{duration}</span>
        )}
      </ToolHeader>
      <ToolContent>
        {!patchFirst && input}
        <div data-transcript-id={`${entry.key}:result`} className="space-y-3">
          {view.output.length > 0 ? (
            <ToolSections sections={view.output} category={view.category} />
          ) : (
            <ToolOutput title={state._tag === "Error" ? "Error" : "Result"}>
              <p className="text-muted-foreground">
                {state._tag === "Running"
                  ? "Waiting for a result…"
                  : state._tag === "Stopped"
                    ? "The session ended before this tool returned a result."
                    : "No output was recorded."}
              </p>
            </ToolOutput>
          )}
        </div>
        {patchFirst && input}
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 px-0 text-muted-foreground data-[panel-open]:[&_svg]:rotate-90"
              />
            }
          >
            <CaretRightIcon aria-hidden="true" />
            Raw details
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
            {Option.match(entry.start, {
              onNone: () => null,
              onSome: ({ input }) => (
                <ToolSections
                  category="tool"
                  sections={[
                    {
                      _tag: "Code",
                      label: "Input payload",
                      text: JSON.stringify(input, null, 2),
                      language: "json",
                    },
                  ]}
                />
              ),
            })}
            {(state._tag === "Finished" || state._tag === "Error") && (
              <ToolSections
                category="tool"
                sections={[
                  {
                    _tag: "Code",
                    label: "Output payload",
                    text: JSON.stringify(state.output, null, 2),
                    language: "json",
                  },
                ]}
              />
            )}
          </CollapsibleContent>
        </Collapsible>
      </ToolContent>
    </Tool>
  );
};

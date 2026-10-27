import { CaretRightIcon } from "@phosphor-icons/react";
import type { RunDetailView } from "@usine/orchestrator/operator";
import { Option } from "effect";
import type { ReactNode } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "~/components/ai-elements/code-block";
import { ItemMark } from "~/components/item/mark";
import { Markdown } from "~/components/markdown";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import { ReaderLine } from "~/components/runs/transcript/transcript";
import { ApprovalLine } from "~/components/runs/approval";
import { RunAgainLine } from "~/components/runs/run-again";
import { eventItem, eventItemRef } from "~/lib/runs/item";

const Page = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <article
      aria-label={label}
      className="mx-auto w-full max-w-[38.5rem] space-y-4 px-4 pt-5 pb-16 sm:px-2"
    >
      {children}
    </article>
  </div>
);

export const TaskDocument = ({ task }: { readonly task: string }) => (
  <Page label="Task">
    <ReaderLine>
      <h2 className="text-lg font-semibold">Task</h2>
      <Markdown className="mt-2 text-md wrap-anywhere">{task}</Markdown>
    </ReaderLine>
  </Page>
);

export const EventDocument = ({
  detail,
}: {
  readonly detail: Pick<RunDetailView, "eventDedupKey" | "eventPayload" | "run">;
}) => {
  const item = eventItem(detail.eventPayload);
  return (
    <Page label="Event">
      <ReaderLine>
        <h2 className="text-lg font-semibold">Event</h2>
        {Option.match(item, {
          onNone: () => (
            <>
              <p className="mt-2 text-md">
                Opened by {detail.run.loop} on {detail.run.repository}
              </p>
              <RunAgainLine run={detail.run} source="link" className="mt-2 block text-sm" />
              <ApprovalLine approval={detail.run.approval} className="mt-2 block text-sm" />
            </>
          ),
          onSome: (event) => (
            <div className="mt-2 space-y-3">
              <p className="text-md">
                {detail.run.loop} matched <ItemMark item={eventItemRef(event)} /> {event.title}
              </p>
              <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">State</dt>
                <dd>{event.state}</dd>
                {event.labels.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">Labels</dt>
                    <dd className="wrap-anywhere">{event.labels.join(", ")}</dd>
                  </>
                )}
                {Option.match(event.author, {
                  onNone: () => null,
                  onSome: (author) => (
                    <>
                      <dt className="text-muted-foreground">Author</dt>
                      <dd>{author}</dd>
                    </>
                  ),
                })}
              </dl>
              <RunAgainLine run={detail.run} source="link" className="block text-sm" />
              <ApprovalLine approval={detail.run.approval} className="block text-sm" />
              {Option.match(event.body, {
                onNone: () => null,
                onSome: (body) => (
                  <Markdown className="border-t pt-3 text-md wrap-anywhere">{body}</Markdown>
                ),
              })}
            </div>
          ),
        })}
      </ReaderLine>
      <ReaderLine>
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="-mx-2 gap-1 px-2 text-muted-foreground data-[panel-open]:[&_svg]:rotate-90"
              />
            }
          >
            <CaretRightIcon aria-hidden="true" />
            Raw details
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-2">
            <p className="font-mono text-xs text-muted-foreground wrap-anywhere">
              {detail.eventDedupKey}
            </p>
            <CodeBlock code={JSON.stringify(detail.eventPayload, null, 2)} language="json">
              <CodeBlockHeader>
                <CodeBlockTitle>Event payload</CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockCopyButton />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          </CollapsibleContent>
        </Collapsible>
      </ReaderLine>
    </Page>
  );
};

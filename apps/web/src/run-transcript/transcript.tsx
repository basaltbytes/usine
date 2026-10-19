import { CaretRightIcon } from "@phosphor-icons/react";
import type { TranscriptPageCursor } from "@usine/orchestrator/operator";
import { DateTime, Match, Option } from "effect";
import type { ReactNode } from "react";
import { ToolContent, Tool } from "@/components/ai-elements/tool";
import { ErrorAlert } from "@/components/error-alert";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";
import {
  clockLabel,
  dayLabel,
  durationLabel,
  harnessLabel,
  poolLabel,
  timestampLabel,
  windowLabel,
} from "../operator-copy.ts";
import { CurrentActivity } from "./activity.tsx";
import type {
  Chapter,
  ChapterRow,
  DelegationRow,
  MessageRow,
  ReaderDocument,
  Speaker,
} from "./document/model.ts";
import { burstSpan, ToolBurst } from "./grouping/burst.tsx";
import { Outcome } from "./outcome.tsx";
import { presentTool } from "./tool/presentation.ts";
import { ToolDetails, useToolDisclosure } from "./tool/tool.tsx";

/** Earlier pages per Attempt, loaded through the page's request and cache seam. */
export interface TranscriptHistory {
  readonly cursors: ReadonlyArray<TranscriptPageCursor>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly load: (cursor: TranscriptPageCursor) => void;
}

/** A reader row: time and speaker in a narrow column, then content at a 72-character measure for 14px prose. */
export const ReaderLine = ({
  gutter,
  children,
  className,
}: {
  readonly gutter?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) => (
  <div
    className={cn(
      "grid min-w-0 gap-x-6 gap-y-0.5 sm:grid-cols-[4.5rem_minmax(0,31.5rem)]",
      className,
    )}
  >
    {gutter === undefined ? (
      <div className="max-sm:hidden" />
    ) : (
      <div className="flex min-w-0 items-baseline gap-2 sm:flex-col sm:items-stretch sm:gap-0">
        {gutter}
      </div>
    )}
    <div className="min-w-0">{children}</div>
  </div>
);

const Gutter = ({
  receivedAt,
  speaker,
  tone = "plain",
}: {
  readonly receivedAt?: string | undefined;
  readonly speaker?: string | null | undefined;
  readonly tone?: "plain" | "failed";
}) => (
  <>
    {receivedAt !== undefined && (
      <time
        dateTime={receivedAt}
        title={timestampLabel(receivedAt)}
        className="font-mono text-xs leading-[1.4rem] tabular-nums text-muted-foreground"
      >
        {clockLabel(receivedAt)}
      </time>
    )}
    {speaker !== null && speaker !== undefined && (
      <span
        className={cn(
          "truncate text-xs font-medium",
          tone === "failed" ? "text-destructive" : "text-foreground",
        )}
      >
        {speaker}
      </span>
    )}
  </>
);

const Message = ({
  row,
  speaker,
}: {
  readonly row: MessageRow;
  readonly speaker: string | null;
}) => (
  <ReaderLine
    gutter={
      <Gutter
        receivedAt={row.receivedAt}
        speaker={speaker}
        tone={row.blocked || row.undelivered ? "failed" : "plain"}
      />
    }
  >
    <div data-transcript-id={row.key} className="min-w-0">
      {row.blocked && <span className="sr-only">Blocked: </span>}
      {row.format === "markdown" ? (
        <Markdown className="text-md wrap-anywhere">{row.text}</Markdown>
      ) : (
        <p className="text-md whitespace-pre-wrap wrap-anywhere">{row.text}</p>
      )}
      {row.undelivered && <p className="text-xs text-destructive">Not delivered</p>}
    </div>
  </ReaderLine>
);

/** The task a session handed to a child, with the delegation's panels one fold away. */
const Delegation = ({
  row,
  speaker,
}: {
  readonly row: DelegationRow;
  readonly speaker: string | null;
}) => {
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
              className="-mx-2 h-auto min-h-7 w-[calc(100%+1rem)] justify-start gap-2 px-2 py-1 text-left text-xs font-normal whitespace-normal text-muted-foreground hover:text-foreground data-[panel-open]:[&>svg]:rotate-90"
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
        <ToolContent className="pl-0">
          <ToolDetails entry={row.tool} view={view} />
        </ToolContent>
      </Tool>
    </ReaderLine>
  );
};

const Row = ({ row, speaker }: { readonly row: ChapterRow; readonly speaker: string | null }) =>
  Match.valueTags(row, {
    Message: (message) => <Message row={message} speaker={speaker} />,
    Note: (note) => (
      <ReaderLine gutter={<Gutter receivedAt={note.receivedAt} speaker={speaker} />}>
        <p
          data-transcript-id={note.key}
          className={cn(
            "text-xs leading-[1.4rem] wrap-anywhere",
            note.undelivered ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {note.text}
        </p>
      </ReaderLine>
    ),
    Burst: (burst) => (
      <ReaderLine gutter={<Gutter speaker={speaker} />}>
        <ToolBurst burst={burst} />
      </ReaderLine>
    ),
    Delegation: (delegation) => <Delegation row={delegation} speaker={speaker} />,
    Ending: (ending) => (
      <ReaderLine
        gutter={
          <Gutter
            receivedAt={Option.getOrUndefined(ending.receivedAt)}
            speaker={speaker}
            tone={ending.end._tag === "Failed" ? "failed" : "plain"}
          />
        }
      >
        <div data-transcript-id={Option.isSome(ending.position) ? ending.key : undefined}>
          <Outcome end={ending.end} />
        </div>
      </ReaderLine>
    ),
  });

const rowSpeaker = (row: ChapterRow): Speaker | null =>
  Match.valueTags(row, {
    Message: ({ speaker }) => speaker,
    Note: ({ speaker }) => speaker,
    Burst: ({ speaker }) => speaker,
    Delegation: ({ speaker }) => speaker,
    Ending: ({ speaker }) => speaker,
  });

const Meta = ({ label, value }: { readonly label: string; readonly value?: ReactNode }) => (
  <span>
    {label}
    {value !== undefined && <> {value}</>}
  </span>
);

const Value = ({ children }: { readonly children: ReactNode }) => (
  <span className="font-mono text-foreground">{children}</span>
);

/** Names the Attempt's Worker, parent model, each child's harness, model and effort, and account readings, once. */
const AttemptMeta = ({
  chapter,
  runTask,
}: {
  readonly chapter: Chapter;
  readonly runTask: string;
}) => {
  const attempt = Option.getOrUndefined(chapter.attempt);
  const parent = chapter.sessions.find(({ session }) => session._tag === "ParentSession");
  const parentModel = Option.orElse(chapter.parentModel, () =>
    Option.fromNullishOr(parent?.session.brain.model),
  );
  const children = [
    ...new Map(
      chapter.sessions
        .filter(({ session }) => session._tag === "ChildSession")
        .map(({ session }) => [
          JSON.stringify([
            session.agent,
            session.brain.harness,
            session.brain.model,
            session.brain.effort,
          ]),
          session,
        ]),
    ).values(),
  ];
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {attempt !== undefined && <Meta label="Worker" value={<Value>{attempt.worker}</Value>} />}
        {Option.match(parentModel, {
          onNone: () => null,
          onSome: (model) => (
            <Meta
              label={
                parent === undefined
                  ? "Parent model"
                  : `Parent on ${harnessLabel(parent.session.brain.harness)},`
              }
              value={<Value>{model}</Value>}
            />
          ),
        })}
        {children.map((child) => (
          <Meta
            key={child.id}
            label={`Child ${child.agent} on ${harnessLabel(child.brain.harness)},`}
            value={
              <>
                <Value>{child.brain.model}</Value>, {child.brain.effort} effort
              </>
            }
          />
        ))}
        {children.length === 0 && attempt !== undefined && (
          <Meta
            label={`Agent ${attempt.agent} on ${harnessLabel(attempt.brain.harness)},`}
            value={
              <>
                <Value>{attempt.brain.model}</Value>, {attempt.brain.effort} effort
              </>
            }
          />
        )}
        {chapter.meters.map((meter) => (
          <Meta
            key={meter.pool}
            label={poolLabel(meter.pool)}
            value={meter.windows
              .map((window) =>
                [
                  `${window.usedPercent}%`,
                  Option.match(window.windowDurationMinutes, {
                    onNone: () => "used",
                    onSome: (minutes) => `of ${windowLabel(minutes)} window`,
                  }),
                  Option.match(window.resetsAt, {
                    onNone: () => "",
                    onSome: (resets) => `, resets ${dayLabel(DateTime.toDate(resets))}`,
                  }),
                ].join(" "),
              )
              .join("; ")
              .replace(/ ,/gu, ",")}
          />
        ))}
        {attempt?.operatorIntervened === true && <Meta label="Operator intervened" />}
      </p>
      {attempt !== undefined && attempt.task !== runTask && (
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="-mx-2 h-7 gap-1 px-2 text-xs font-normal text-muted-foreground data-[panel-open]:[&_svg]:rotate-90"
              />
            }
          >
            <CaretRightIcon aria-hidden="true" />
            Task used by this Attempt
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1">
            <Markdown className="text-sm">{attempt.task}</Markdown>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};

const ChapterView = ({
  chapter,
  first,
  runTask,
  history,
}: {
  readonly chapter: Chapter;
  readonly first: boolean;
  readonly runTask: string;
  readonly history: TranscriptHistory;
}) => {
  const cursor = history.cursors.find(({ attemptId }) => attemptId === chapter.attemptId);
  let previous: Speaker | null = null;
  const rows = chapter.rows.map((row) => {
    const speaker = rowSpeaker(row);
    const changed =
      speaker !== null &&
      (previous === null ||
        previous.name !== speaker.name ||
        previous.sessionKey !== speaker.sessionKey);
    if (speaker !== null) previous = speaker;
    return { row, speaker: changed ? speaker.name : null };
  });
  return (
    <>
      <MessageScrollerItem messageId={chapter.key} className={first ? undefined : "mt-10"}>
        <ReaderLine className={first ? undefined : "border-t pt-8"}>
          <h2 className="text-md font-semibold">
            {Option.match(chapter.attempt, {
              onNone: () => "Attempt",
              onSome: ({ number }) => `Attempt ${number}`,
            })}
          </h2>
          <AttemptMeta chapter={chapter} runTask={runTask} />
        </ReaderLine>
      </MessageScrollerItem>
      {cursor !== undefined && (
        <MessageScrollerItem messageId={`history:${chapter.attemptId}`} className="mt-4">
          <ReaderLine>
            <Button
              variant="outline"
              size="sm"
              disabled={history.loading}
              onClick={() => history.load(cursor)}
            >
              {history.loading ? "Loading…" : "Load earlier"}
            </Button>
            {history.error !== null && <ErrorAlert className="mt-2" message={history.error} />}
          </ReaderLine>
        </MessageScrollerItem>
      )}
      {rows.length === 0 && cursor === undefined && !chapter.live && (
        <MessageScrollerItem messageId={`empty:${chapter.attemptId}`} className="mt-4">
          <ReaderLine>
            <p className="text-xs text-muted-foreground">No activity was recorded.</p>
          </ReaderLine>
        </MessageScrollerItem>
      )}
      {rows.map(({ row, speaker }) => (
        <MessageScrollerItem
          key={row.key}
          messageId={row.key}
          className={row._tag === "Burst" ? "mt-0.5" : row._tag === "Note" ? "mt-2" : "mt-4"}
        >
          <Row row={row} speaker={speaker} />
        </MessageScrollerItem>
      ))}
      {chapter.live && (
        <MessageScrollerItem
          messageId={`activity:${chapter.attemptId}`}
          className="mt-4 [content-visibility:visible]"
        >
          <ReaderLine>
            <CurrentActivity chapter={chapter} />
          </ReaderLine>
        </MessageScrollerItem>
      )}
    </>
  );
};

/** The Run's Attempts as one document: a heading and metadata line per Attempt, then its rows in order. */
export const Transcript = ({
  document,
  runTask,
  history,
}: {
  readonly document: ReaderDocument;
  readonly runTask: string;
  readonly history: TranscriptHistory;
}) => {
  if (document.chapters.length === 0)
    return (
      <MessageScrollerItem messageId="empty">
        <ReaderLine>
          <p className="text-xs text-muted-foreground">No Attempt has started.</p>
        </ReaderLine>
      </MessageScrollerItem>
    );
  return document.chapters.map((chapter, index) => (
    <ChapterView
      key={chapter.key}
      chapter={chapter}
      first={index === 0}
      runTask={runTask}
      history={history}
    />
  ));
};

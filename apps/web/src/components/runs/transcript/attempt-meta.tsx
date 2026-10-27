import { CaretRightIcon } from "@phosphor-icons/react";
import { DateTime, Option } from "effect";
import { Markdown } from "~/components/markdown";
import { Meta } from "~/components/runs/transcript/meta";
import { Value } from "~/components/runs/transcript/value";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import type { Chapter } from "~/lib/runs/transcript/document/model";
import { dayLabel, harnessLabel, poolLabel, windowLabel } from "~/lib/strings";

type AttemptMetaProps = {
  readonly chapter: Chapter;
  readonly runTask: string;
};

export const AttemptMeta = ({ chapter, runTask }: AttemptMetaProps) => {
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
            Task used by this attempt
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1">
            <Markdown className="text-sm">{attempt.task}</Markdown>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};

import type { StalledItemView } from "@usine/orchestrator/operator";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StallAction } from "../stall/action.tsx";
import { stallSentence } from "../stall/copy.ts";
import { stallRun } from "../task/model.ts";
import { EmptyLine, ItemTitle, RunPageLink, RunRow } from "./section.tsx";

const StalledRow = ({
  stalled,
  now,
  readOnly,
  narrow,
}: {
  readonly stalled: StalledItemView;
  readonly now: number;
  readonly readOnly: boolean;
  /** Whether to render the row as a single cell, as below the `md` breakpoint. */
  readonly narrow: boolean;
}) => {
  const run = stallRun(stalled);
  const title = <ItemTitle item={stalled.item} />;
  const item = run === null ? title : <RunPageLink run={run}>{title}</RunPageLink>;
  const action = <StallAction stalled={stalled} readOnly={readOnly} appearance="row" />;
  if (narrow)
    return (
      <RunRow run={run}>
        <TableCell className="w-full max-w-0 py-3 align-top whitespace-normal">
          {item}
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{stalled.loop}</p>
          <p className="mt-1 text-sm text-foreground/90">{stallSentence(stalled, now)}</p>
          <div className="-ml-2.5 empty:hidden [&>span]:items-start">{action}</div>
        </TableCell>
      </RunRow>
    );
  return (
    <RunRow run={run}>
      <TableCell className="w-2/5 max-w-0 py-3 align-top whitespace-normal">{item}</TableCell>
      <TableCell className="py-3 align-top">{stalled.loop}</TableCell>
      <TableCell className="w-3/5 py-3 align-top whitespace-normal text-foreground/90">
        {stallSentence(stalled, now)}
      </TableCell>
      <TableCell className="py-2 text-right align-top">{action}</TableCell>
    </RunRow>
  );
};

/**
 * Renders the matched Items with no running Attempt; a row whose reason references a Run opens it.
 * `readOnly` hides the actions during setup; `polled` is false until the first repository poll ends.
 */
export const NotMoving = ({
  stalled,
  now,
  readOnly,
  polled,
}: {
  readonly stalled: ReadonlyArray<StalledItemView>;
  readonly now: number;
  readonly readOnly: boolean;
  readonly polled: boolean;
}) => {
  const narrow = useIsMobile();
  if (stalled.length === 0)
    return <EmptyLine>{polled ? "Nothing stalled" : "No poll has finished yet"}</EmptyLine>;
  return (
    <div className="-mx-2">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Item</TableHead>
            {!narrow && (
              <>
                <TableHead>Loop</TableHead>
                <TableHead>Why</TableHead>
                <TableHead>
                  <span className="sr-only">Action</span>
                </TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {stalled.map((entry) => (
            <StalledRow
              key={`${entry.loop}:${entry.item.itemKey}`}
              stalled={entry}
              now={now}
              readOnly={readOnly}
              narrow={narrow}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

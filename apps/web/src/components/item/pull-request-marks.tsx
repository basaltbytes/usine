import { cn } from "~/lib/utils";
import { ItemMark, type ItemRef } from "~/components/item/mark";

/** Renders pull requests as item marks in the given order, or nothing if there are none. */
export const PullRequestMarks = ({
  pullRequests,
  linked = true,
  className,
}: {
  readonly pullRequests: ReadonlyArray<ItemRef>;
  /** Whether the marks link to GitHub; pass `false` inside another link or button. */
  readonly linked?: boolean;
  readonly className?: string;
}) =>
  pullRequests.length === 0 ? null : (
    <span className={cn("inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5", className)}>
      {pullRequests.map((pullRequest) => (
        <ItemMark key={pullRequest.number} item={pullRequest} linked={linked} />
      ))}
    </span>
  );

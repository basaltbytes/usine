import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  type Icon,
  IssueClosedIcon,
  IssueOpenedIcon,
} from "@primer/octicons-react";
import type { LaneItemState } from "@usine/config/board";
import { cn } from "@/lib/utils";

/** A GitHub issue or pull request; a `null` state is unknown. */
export interface ItemRef {
  readonly kind: "issue" | "pr";
  readonly number: number;
  readonly url: string;
  readonly state: LaneItemState | null;
}

const looks = {
  "issue-open": { icon: IssueOpenedIcon, tone: "text-run-succeeded", word: "open" },
  "issue-closed": { icon: IssueClosedIcon, tone: "text-primary", word: "closed" },
  "issue-unknown": { icon: IssueOpenedIcon, tone: "text-muted-foreground", word: null },
  "pr-open": { icon: GitPullRequestIcon, tone: "text-run-succeeded", word: "open" },
  "pr-merged": { icon: GitMergeIcon, tone: "text-primary", word: "merged" },
  "pr-closed": { icon: GitPullRequestClosedIcon, tone: "text-run-failed", word: "closed" },
  "pr-unknown": { icon: GitPullRequestIcon, tone: "text-muted-foreground", word: null },
} as const satisfies Record<
  LaneItemState | "issue-unknown" | "pr-unknown",
  { readonly icon: Icon; readonly tone: string; readonly word: string | null }
>;

const lookOf = ({ kind, state }: Pick<ItemRef, "kind" | "state">) =>
  looks[state ?? `${kind}-unknown`];

const kindWord = (kind: ItemRef["kind"]) => (kind === "pr" ? "Pull request" : "Issue");

/** Returns the item's kind and number for a sentence, for example `issue #481`. */
export const itemName = ({ kind, number }: Pick<ItemRef, "kind" | "number">): string =>
  `${kindWord(kind).toLowerCase()} #${number}`;

/** Returns the item's kind, number, and state if known, for example `Pull request #530, closed`. */
export const itemLabel = (item: Pick<ItemRef, "kind" | "number" | "state">): string => {
  const { word } = lookOf(item);
  return `${kindWord(item.kind)} #${item.number}${word === null ? "" : `, ${word}`}`;
};

/**
 * Renders the item's GitHub icon and `#number` in its state colour, with `itemLabel` as tooltip and
 * accessible name. `linked` marks open GitHub in a new tab; pass `false` inside another link,
 * button, or menu item. `title` size sits on the baseline of a 16px or 20px title.
 */
export const ItemMark = ({
  item,
  size = "inline",
  linked = true,
  numbered = true,
  className,
}: {
  readonly item: ItemRef;
  readonly size?: "inline" | "title";
  readonly linked?: boolean;
  /** Whether to show `#number` after the icon; an icon alone still has `itemLabel` as its name. */
  readonly numbered?: boolean;
  readonly className?: string;
}) => {
  const { icon: Glyph, tone } = lookOf(item);
  const label = itemLabel(item);
  const classes = cn(
    "inline-flex items-baseline gap-1 whitespace-nowrap",
    size === "title" && "gap-1.5",
    tone,
    className,
  );
  const mark = (
    <>
      <Glyph size={size === "title" ? 16 : 14} className="shrink-0 self-center" />
      {numbered && (
        <span className={cn("font-mono tabular-nums", size === "title" ? "text-md" : "text-xs")}>
          #{item.number}
        </span>
      )}
    </>
  );
  return linked ? (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      draggable={false}
      title={label}
      aria-label={label}
      className={cn(
        classes,
        "rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/70",
      )}
    >
      {mark}
    </a>
  ) : (
    <span role="img" title={label} aria-label={label} className={classes}>
      {mark}
    </span>
  );
};

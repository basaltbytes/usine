import { GithubLogoIcon } from "@phosphor-icons/react";
import type { LabelView, ReviewedView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { Fragment, type ReactNode } from "react";
import { LabelBadge } from "@/components/label-badge";
import { timestampLabel } from "../operator-copy.ts";
import type { GitHubChangeRow, LabelChanges } from "./document/model.ts";

const reviewed = {
  APPROVED: (item) => <>Approved {item}</>,
  CHANGES_REQUESTED: (item) => <>Requested changes on {item}</>,
  COMMENTED: (item) => <>Reviewed {item}</>,
  DISMISSED: (item) => <>Reviewed {item}, since dismissed</>,
} satisfies Record<ReviewedView["state"], (item: ReactNode) => ReactNode>;

/** The Item number in a comment or review URL, linking to that comment or review. */
const ItemLink = ({ url, what }: { readonly url: string; readonly what: string }) => {
  const number = /\/(?:issues|pull)\/(\d+)/u.exec(url)?.[1];
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Open the ${what} on GitHub`}
      className="font-mono text-primary underline-offset-4 hover:underline"
    >
      {number === undefined ? "GitHub" : `#${number}`}
    </a>
  );
};

const Chips = ({ labels }: { readonly labels: ReadonlyArray<LabelView> }) =>
  labels.map((label, index) => (
    <Fragment key={label.name}>
      {index > 0 && " "}
      <LabelBadge name={label.name} label={label} />
    </Fragment>
  ));

const Labels = ({ change }: { readonly change: LabelChanges }) => {
  const removed = change.removed.length > 0;
  return (
    <>
      {removed && (
        <>
          Removed <Chips labels={change.removed} />
        </>
      )}
      {change.added.length > 0 && (
        <>
          {removed ? ", added " : "Added "}
          <Chips labels={change.added} />
        </>
      )}
    </>
  );
};

/** One quiet line for a change an Agent made on the Run's GitHub Item, its labels in their GitHub colors. */
export const GitHubChangeLine = ({ row }: { readonly row: GitHubChangeRow }) => (
  <div
    title={`GitHub recorded this at ${timestampLabel(row.at)}`}
    className="flex min-h-7 min-w-0 items-start gap-2 py-1 text-xs text-muted-foreground"
  >
    <GithubLogoIcon aria-hidden="true" className="mt-0.75 size-3.5 shrink-0" />
    <p className="min-w-0 leading-5 wrap-anywhere">
      {Match.valueTags(row.change, {
        Labels: (change) => <Labels change={change} />,
        Commented: ({ url }) => (
          <>
            Commented on <ItemLink url={url} what="comment" />
          </>
        ),
        Reviewed: ({ url, state }) => reviewed[state](<ItemLink url={url} what="review" />),
      })}
    </p>
  </div>
);

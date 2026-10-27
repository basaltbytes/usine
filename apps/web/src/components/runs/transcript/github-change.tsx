import { GithubLogoIcon } from "@phosphor-icons/react";
import type { LabelView, ReviewedView } from "@usine/orchestrator/operator";
import { Match } from "effect";
import { Fragment, type ReactNode } from "react";
import { ItemMark } from "~/components/item/mark";
import { LabelBadge } from "~/components/label-badge";
import { timestampLabel } from "~/lib/strings";
import type { GitHubChangeRow, LabelChanges } from "~/lib/runs/transcript/document/model";

const reviewed = {
  APPROVED: (item) => <>Approved {item}</>,
  CHANGES_REQUESTED: (item) => <>Requested changes on {item}</>,
  COMMENTED: (item) => <>Reviewed {item}</>,
  DISMISSED: (item) => <>Reviewed {item}, since dismissed</>,
} satisfies Record<ReviewedView["state"], (item: ReactNode) => ReactNode>;

/** Renders the item of a comment or review URL as a mark that links to the comment or review. */
const ItemLink = ({ url }: { readonly url: string }) => {
  const match = /\/(issues|pull)\/(\d+)/u.exec(url);
  return match?.[1] === undefined || match[2] === undefined ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline-offset-4 hover:underline"
    >
      GitHub
    </a>
  ) : (
    <ItemMark
      item={{
        kind: match[1] === "pull" ? "pr" : "issue",
        number: Number(match[2]),
        url,
        state: null,
      }}
    />
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
            Commented on <ItemLink url={url} />
          </>
        ),
        Reviewed: ({ url, state }) => reviewed[state](<ItemLink url={url} />),
      })}
    </p>
  </div>
);

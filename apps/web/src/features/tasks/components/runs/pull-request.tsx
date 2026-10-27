import { Option } from "effect";
import { ItemMark, type ItemRef } from "~/components/item/mark";

type PullRequestProps = { readonly pullRequest: Option.Option<ItemRef> };

/** Renders the Run's pull request mark above the row link. */
export const PullRequest = ({ pullRequest }: PullRequestProps) =>
  Option.match(pullRequest, {
    onNone: () => null,
    onSome: (item) => <ItemMark item={item} className="relative z-10" />,
  });

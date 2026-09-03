import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { Item, Repository } from "@usine/core";
import type { RunView } from "@usine/orchestrator";
import { Option, Schema } from "effect";
import { Button } from "@/components/ui/button";

const GitHubItemKey = Schema.fromJsonString(
  Schema.Tuple([Schema.Literal("github"), Repository.Name, Item.Number]),
);
const decodeGitHubItemKey = Schema.decodeUnknownOption(GitHubItemKey);

type LinkedRun = Pick<RunView, "itemKey" | "repository" | "pullRequestUrl">;

const githubItem = ({ itemKey, repository }: Pick<LinkedRun, "itemKey" | "repository">) =>
  Option.match(decodeGitHubItemKey(itemKey), {
    onNone: () => null,
    onSome: ([, itemRepository, number]) =>
      Repository.canonical(itemRepository) === Repository.canonical(repository)
        ? { href: `https://github.com/${repository}/issues/${number}`, number }
        : null,
  });

const ExternalLink = ({
  href,
  label,
  accessibleLabel,
}: {
  readonly href: string;
  readonly label: string;
  readonly accessibleLabel: string;
}) => (
  <Button
    variant="link"
    size="sm"
    className="h-auto p-0 font-mono"
    nativeButton={false}
    render={
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={accessibleLabel}
        draggable={false}
      />
    }
  >
    {label}
    <ArrowSquareOutIcon data-icon="inline-end" aria-hidden="true" />
  </Button>
);

export const RunLinks = ({ run }: { readonly run: LinkedRun }) => {
  const item = githubItem(run);
  if (item === null && run.pullRequestUrl === null) return null;
  return (
    <span className="flex items-center gap-2">
      {item !== null && (
        <ExternalLink
          href={item.href}
          label={`Item #${item.number}`}
          accessibleLabel={`Open Item #${item.number} on GitHub`}
        />
      )}
      {run.pullRequestUrl !== null && (
        <ExternalLink
          href={run.pullRequestUrl}
          label="PR"
          accessibleLabel="Open produced pull request on GitHub"
        />
      )}
    </span>
  );
};

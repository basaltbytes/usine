import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { RunView } from "@usine/orchestrator/operator/model";
import { GitHubItemKey } from "@usine/orchestrator/polling-triggers";
import { Option, Schema } from "effect";
import { Button } from "@/components/ui/button";

const decodeGitHubItemKey = Schema.decodeOption(GitHubItemKey);

type LinkedRun = Pick<RunView, "itemKey" | "pullRequestUrl">;

/** Schedule Runs key the repository itself rather than an issue or pull request, so they have no Item link.
 * GitHub resolves `/issues/N` to `/pull/N` and canonical (lowercased) owner/name to the display casing. */
const githubItem = (itemKey: LinkedRun["itemKey"]) =>
  Option.match(decodeGitHubItemKey(itemKey), {
    onNone: () => null,
    onSome: ([, repository, number]) => ({
      href: `https://github.com/${repository}/issues/${number}`,
      number,
    }),
  });

const ExternalLink = ({ href, label }: { readonly href: string; readonly label: string }) => (
  <Button
    variant="link"
    size="sm"
    className="h-auto p-0 font-mono"
    nativeButton={false}
    render={<a href={href} target="_blank" rel="noreferrer" draggable={false} />}
  >
    {label}
    <ArrowSquareOutIcon data-icon="inline-end" aria-hidden="true" />
  </Button>
);

export const RunLinks = ({ run }: { readonly run: LinkedRun }) => {
  const item = githubItem(run.itemKey);
  if (item === null && run.pullRequestUrl === null) return null;
  return (
    <span className="flex items-center gap-2">
      {item !== null && <ExternalLink href={item.href} label={`Item #${item.number}`} />}
      {run.pullRequestUrl !== null && <ExternalLink href={run.pullRequestUrl} label="PR" />}
    </span>
  );
};

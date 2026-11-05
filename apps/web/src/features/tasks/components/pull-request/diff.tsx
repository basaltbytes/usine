import { Diff } from "@balade/viewer";
import type { FileChanges } from "@usine/github/files";
import "@balade/viewer/viewer.css";
import "~/features/tasks/components/pull-request/diff.css";

type PullRequestDiffProps = {
  readonly changes: FileChanges;
  readonly repository: string;
};

export const PullRequestDiff = ({ changes, repository }: PullRequestDiffProps) => (
  <Diff
    className="task-diff"
    defaultExpanded={false}
    files={changes.files.map(({ oldPath, ...file }) =>
      oldPath === null ? file : { ...file, oldPath },
    )}
    fileHref={(file) =>
      `https://github.com/${repository}/blob/${file.status === "removed" ? changes.base : changes.head}/${file.path.split("/").map(encodeURIComponent).join("/")}`
    }
  />
);

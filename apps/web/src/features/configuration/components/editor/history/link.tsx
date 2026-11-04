import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ConfigurationEntityKey } from "@usine/config/configuration";
import { formatDistanceToNow } from "date-fns";
import { DateTime } from "effect";
import { latestRevisionQuery } from "~/features/configuration/queries";
import { editorCopy, historyCopy } from "~/features/configuration/strings";

type EntityHistoryLinkProps = { readonly entity: ConfigurationEntityKey };

export const EntityHistoryLink = ({ entity }: EntityHistoryLinkProps) => {
  const history = useQuery(latestRevisionQuery(entity));
  const revision = history.data?.revisions[0];
  return (
    <Link
      to="/configuration/history"
      search={{ kind: entity.kind, identifier: entity.identifier }}
      aria-label={historyCopy.forEntity(entity.key)}
      className="inline-flex min-h-7 flex-wrap items-center gap-x-1 rounded-sm text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {revision === undefined ? (
        historyCopy.view
      ) : (
        <>
          {historyCopy.changedBy(revision.actor ?? editorCopy.localOperator)} ·{" "}
          <time
            dateTime={DateTime.formatIso(revision.time)}
            title={DateTime.formatIso(revision.time)}
          >
            {formatDistanceToNow(DateTime.toDateUtc(revision.time), { addSuffix: true })}
          </time>
        </>
      )}
      {history.isError && <span>{historyCopy.unavailable}</span>}
    </Link>
  );
};

import { useContext } from "react";
import { useNow } from "~/hooks/use-now";
import { refreshCopy } from "~/lib/strings";
import { RefreshContext } from "./provider";

export const RefreshStatus = () => {
  const sources = useContext(RefreshContext);
  const now = useNow(1_000);
  if (sources.length === 0) return null;
  const successful = sources.map((source) => source.updatedAt).filter((time) => time > 0);
  const updatedAt = successful.length === 0 ? 0 : Math.min(...successful);
  const failed = [
    ...new Set(
      sources
        .filter(({ failedSince }) => failedSince !== null && now - failedSince > 60_000)
        .map(({ label }) => label),
    ),
  ];
  return (
    <p className="w-full text-xs text-muted-foreground" aria-label={refreshCopy.label}>
      {updatedAt === 0 ? (
        refreshCopy.waiting
      ) : (
        <>
          {refreshCopy.label}{" "}
          <time
            dateTime={new Date(updatedAt).toISOString()}
            title={new Date(updatedAt).toLocaleString()}
            className="font-mono tabular-nums"
          >
            {new Date(updatedAt).toLocaleTimeString()}
          </time>
        </>
      )}
      {failed.length > 0 && <span role="status">{refreshCopy.failed(failed.join(", "))}</span>}
    </p>
  );
};

import { useContext } from "react";
import { useNow } from "~/hooks/use-now";
import { refreshCopy } from "~/lib/strings";
import { RefreshContext } from "./provider";
import { TextTooltip } from "~/components/text-tooltip";

export const RefreshStatus = () => {
  const { sources, connection } = useContext(RefreshContext);
  const now = useNow(1_000);
  if (sources.length === 0) return null;
  const successful = sources.map((source) => source.updatedAt).filter((time) => time > 0);
  const updatedAt = successful.length === 0 ? 0 : Math.max(...successful);
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
          <TextTooltip text={new Date(updatedAt).toLocaleString()}>
            <time dateTime={new Date(updatedAt).toISOString()} className="font-mono tabular-nums">
              {new Date(updatedAt).toLocaleTimeString()}
            </time>
          </TextTooltip>
        </>
      )}
      {connection === "disconnected" && <span role="status">{refreshCopy.disconnected}</span>}
      {failed.length > 0 && <span role="status">{refreshCopy.failed(failed.join(", "))}</span>}
    </p>
  );
};

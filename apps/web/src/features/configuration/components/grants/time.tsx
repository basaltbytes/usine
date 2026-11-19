import { DateTime } from "effect";
import { TextTooltip } from "~/components/text-tooltip";
import { dayTimeLabel, timestampLabel } from "~/lib/strings";

type TimeProps = { readonly at: DateTime.Utc };

/** A local day and minute, with the full timestamp on hover. */
export const Time = ({ at }: TimeProps) => {
  const instant = DateTime.formatIso(at);
  return (
    <TextTooltip text={timestampLabel(instant)}>
      <time dateTime={instant} className="font-mono text-xs tabular-nums">
        {dayTimeLabel(instant)}
      </time>
    </TextTooltip>
  );
};

import { useEffect, useMemo } from "react";
import { useMessageScrollerVisibility } from "~/components/ui/message-scroller";
import {
  readingOrder,
  readingPlace,
  type ReaderDocument,
  type ReadingPlace,
} from "~/lib/runs/transcript/document/model";

type TrackReadingProps = {
  readonly document: ReaderDocument;
  readonly active: boolean;
  readonly onReading: (place: ReadingPlace) => void;
};

/** Reports the reading position while the reader is shown. */
export const TrackReading = ({ document, active, onReading }: TrackReadingProps) => {
  const { visibleMessageIds } = useMessageScrollerVisibility();
  const order = useMemo(() => readingOrder(document), [document]);
  const place = readingPlace(order, visibleMessageIds);
  const attemptId = place?.attemptId;
  const checkpointKey = place?.checkpointKey ?? null;
  useEffect(() => {
    if (active && attemptId !== undefined) onReading({ attemptId, checkpointKey });
  }, [active, attemptId, checkpointKey, onReading]);
  return null;
};

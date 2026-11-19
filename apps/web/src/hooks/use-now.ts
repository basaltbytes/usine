import { useEffect, useState } from "react";

/** Returns the current time in epoch milliseconds, updated every `intervalMs`. */
export const useNow = (intervalMs: number): number => {
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line usine/no-unreasoned-effect -- Advance the displayed clock from a browser interval.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
};

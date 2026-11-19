import { useQuery } from "@tanstack/react-query";
import type { ConfigurationRevisionNumber } from "@usine/config/configuration";
import { useEffect, useState } from "react";
import { configurationWritesQuery } from "~/features/configuration/queries";
import { editorCopy } from "~/features/configuration/strings";

/** How long a save runs before the form names its step. */
const SLOW_SAVE_MILLIS = 3000;

type SaveProgressProps = {
  /** The revision that the running save expects to replace. */
  readonly expected: ConfigurationRevisionNumber;
};

/** Names the step that a save on top of `expected` runs, once the save takes a few seconds. */
export const SaveProgress = ({ expected }: SaveProgressProps) => {
  const [slow, setSlow] = useState(false);
  // oxlint-disable-next-line usine/no-unreasoned-effect -- A browser timer reveals the step of a save that takes a few seconds.
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_SAVE_MILLIS);
    return () => clearTimeout(timer);
  }, []);
  const writes = useQuery({ ...configurationWritesQuery(), enabled: slow });
  if (!slow) return null;
  const step = writes.data?.find((write) => write.expected === expected)?.step;
  return (
    <p role="status" className="text-muted-foreground">
      {step === undefined ? editorCopy.savingSlowly : editorCopy.saveStep(step)}
    </p>
  );
};

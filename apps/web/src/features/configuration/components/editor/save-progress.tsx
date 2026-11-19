import { useQuery } from "@tanstack/react-query";
import type { ConfigurationSaveId } from "@usine/orchestrator/operator/http";
import { useEffect, useState } from "react";
import { configurationWritesQuery } from "~/features/configuration/queries";
import { editorCopy } from "~/features/configuration/strings";

/** How long a save runs before the form names its step. */
const SLOW_SAVE_MILLIS = 3000;

type SaveProgressProps = {
  /** The ID that the form gave the running save. */
  readonly save: ConfigurationSaveId;
};

/** Names the step that the save `save` runs, once the save takes a few seconds. */
export const SaveProgress = ({ save }: SaveProgressProps) => {
  const [slow, setSlow] = useState(false);
  // oxlint-disable-next-line usine/no-unreasoned-effect -- A browser timer reveals the step of a save that takes a few seconds.
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_SAVE_MILLIS);
    return () => clearTimeout(timer);
  }, []);
  const writes = useQuery({ ...configurationWritesQuery(), enabled: slow });
  if (!slow) return null;
  const step = writes.data?.find((write) => write.save === save)?.step;
  return (
    <p role="status" className="text-muted-foreground">
      {step === undefined ? editorCopy.savingSlowly : editorCopy.saveStep(step)}
    </p>
  );
};

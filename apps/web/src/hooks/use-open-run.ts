import { useNavigate } from "@tanstack/react-router";
import type { RunId } from "@usine/core/run";

/** Returns a function that opens the Run drawer over the current route by setting the `run` search param. */
export const useOpenRun = () => {
  const navigate = useNavigate();
  return (runId: RunId) =>
    void navigate({ to: ".", search: (previous) => ({ ...previous, run: runId }) });
};

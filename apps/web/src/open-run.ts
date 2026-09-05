import { useNavigate } from "@tanstack/react-router";
import type { RunId } from "@usine/core/run";

/** Opens the drawer over the current screen by writing the run id into the root search. */
export const useOpenRun = () => {
  const navigate = useNavigate();
  return (runId: RunId) =>
    void navigate({ to: ".", search: (previous) => ({ ...previous, run: runId }) });
};

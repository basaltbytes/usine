import { StatusBadge } from "~/components/status-badge";

type LoopStateProps = { readonly paused: boolean };

export const LoopState = ({ paused }: LoopStateProps) => (
  <StatusBadge state={paused ? "paused" : "live"} label={paused ? "Paused" : "Active"} />
);

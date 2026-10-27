import type { TranscriptSession } from "~/lib/runs/transcript/model";

export const sessionName = (session: TranscriptSession) =>
  session.session._tag === "ParentSession" ? "Parent" : session.session.agent;

export const checkpointRow =
  "flex h-6.5 w-full min-w-0 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-left outline-none transition-colors duration-(--duration-fast) ease-out-expo hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/70 aria-[current=location]:font-medium";

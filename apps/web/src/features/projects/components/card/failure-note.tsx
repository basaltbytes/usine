import type { ReactNode } from "react";
import { type RunFailure } from "~/lib/projects/failure";

type FailureNoteProps = {
  readonly failure: RunFailure;
  readonly children: ReactNode;
};

export const FailureNote = ({ failure, children }: FailureNoteProps) => (
  <div className="flex flex-col items-start gap-1.5 rounded-md bg-destructive/8 px-2 py-1.5 text-xs text-destructive">
    <p className="line-clamp-2 wrap-anywhere" title={failure.message}>
      {failure.message}
    </p>
    {children}
  </div>
);

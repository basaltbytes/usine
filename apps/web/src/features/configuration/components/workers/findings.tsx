import { useId } from "react";
import { preflightFindingsLabel } from "~/features/configuration/strings";

type PreflightFindingsProps = { readonly findings: ReadonlyArray<string> };

/** Lists what the Worker's last machine preflight found missing; renders nothing without any. */
export const PreflightFindings = ({ findings }: PreflightFindingsProps) => {
  const labelId = useId();
  if (findings.length === 0) return null;
  return (
    <div className="space-y-1">
      <p id={labelId} className="font-medium">
        {preflightFindingsLabel}
      </p>
      <ul aria-labelledby={labelId} className="list-disc space-y-1 pl-4 text-warning">
        {findings.map((finding) => (
          <li key={finding} className="wrap-anywhere">
            {finding}
          </li>
        ))}
      </ul>
    </div>
  );
};

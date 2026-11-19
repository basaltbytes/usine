import { useState } from "react";
import { Button } from "~/components/ui/button";

type TwoStepButtonProps = {
  readonly label: string;
  /** The first button's label while the confirmation shows, which steps back. */
  readonly keepLabel: string;
  readonly confirmLabel: string;
  /** The confirmation's label while `pending`; `confirmLabel` without one. */
  readonly pendingLabel?: string;
  readonly pending: boolean;
  readonly confirm: () => void;
};

/**
 * A destructive action in two steps. The first button keeps its place as it changes to the keep
 * label, so a double click doesn't confirm.
 */
export const TwoStepButton = ({
  label,
  keepLabel,
  confirmLabel,
  pendingLabel = confirmLabel,
  pending,
  confirm,
}: TwoStepButtonProps) => {
  const [confirming, setConfirming] = useState(false);
  return (
    <span className="flex flex-wrap gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="pointer-coarse:h-11"
        disabled={pending}
        onClick={() => setConfirming(!confirming)}
      >
        {confirming ? keepLabel : label}
      </Button>
      {confirming && (
        <Button
          variant="destructive"
          size="sm"
          className="pointer-coarse:h-11"
          disabled={pending}
          onClick={confirm}
        >
          {pending ? pendingLabel : confirmLabel}
        </Button>
      )}
    </span>
  );
};

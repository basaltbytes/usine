// Adapted from Vercel AI Elements. See README.md and LICENSE in this folder.
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { Button } from "~/components/ui/button";

/** Copies the original content and reports clipboard denial beside the control. */
export const CopyButton = ({
  value,
  label,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick" | "children"> & {
  value: string;
  label: string;
}) => {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const copy = async () => {
    setStatus("copying");
    clearTimeout(timeoutRef.current);
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
      timeoutRef.current = setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("failed");
    }
  };

  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={status === "copied" ? "Copied" : label}
        title={status === "copied" ? "Copied" : label}
        disabled={status === "copying"}
        onClick={copy}
        {...props}
      >
        {status === "copied" ? <CheckIcon /> : <CopyIcon />}
      </Button>
      <span role="status" className={status === "failed" ? "text-xs text-destructive" : "sr-only"}>
        {status === "failed"
          ? "Copy failed. Select the text to copy it."
          : status === "copied"
            ? "Copied to clipboard"
            : ""}
      </span>
    </>
  );
};

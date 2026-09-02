import { WarningCircleIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export const ErrorAlert = ({
  title,
  message,
  className,
}: {
  readonly title?: string;
  readonly message: string;
  readonly className?: string;
}) => (
  <Alert variant="destructive" className={cn("wrap-anywhere", className)}>
    <WarningCircleIcon weight="fill" />
    {title !== undefined && <AlertTitle>{title}</AlertTitle>}
    <AlertDescription>{message}</AlertDescription>
  </Alert>
);

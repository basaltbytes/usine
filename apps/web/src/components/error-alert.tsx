import { WarningCircleIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { cn } from "~/lib/utils";

type ErrorAlertProps = {
  readonly title?: string;
  readonly message: string;
  readonly className?: string;
};

export const ErrorAlert = ({ title, message, className }: ErrorAlertProps) => (
  <Alert variant="destructive" className={cn("wrap-anywhere", className)}>
    <WarningCircleIcon weight="fill" />
    {title !== undefined && <AlertTitle>{title}</AlertTitle>}
    <AlertDescription>{message}</AlertDescription>
  </Alert>
);

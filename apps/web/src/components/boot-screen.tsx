import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** Placeholder for the loading, unreachable, and not-found states shown before a screen can render.
 * It fills the viewport, or the work panel below Needs you when `inPanel`. */
export const BootScreen = ({
  title,
  description,
  tone = "loading",
  inPanel = false,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly tone?: "loading" | "error";
  readonly inPanel?: boolean;
  readonly children?: ReactNode;
}) => (
  <main className={cn("grid place-items-center p-6", inPanel ? "flex-1" : "min-h-svh")}>
    <Empty className="max-w-md p-0">
      <EmptyHeader className="gap-2">
        <EmptyMedia
          className={cn(
            "mb-1 [&_svg]:size-5",
            tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {tone === "loading" ? <Spinner /> : <WarningCircleIcon weight="fill" />}
        </EmptyMedia>
        <EmptyTitle className="text-md font-semibold tracking-normal">{title}</EmptyTitle>
        <EmptyDescription className="text-sm text-muted-foreground wrap-anywhere">
          {description}
        </EmptyDescription>
      </EmptyHeader>
      {children !== undefined && <EmptyContent className="mt-1">{children}</EmptyContent>}
    </Empty>
  </main>
);

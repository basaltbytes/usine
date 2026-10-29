import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { UsineMark } from "~/components/usine-mark";
import { cn } from "~/lib/utils";

type BootScreenProps = {
  readonly title: string;
  readonly description: string;
  readonly tone?: "loading" | "error";
  readonly inPanel?: boolean;
  readonly children?: ReactNode;
};

/** Renders the loading, unreachable, or not-found screen in the viewport, or in the work panel below Needs you if `inPanel` is set. */
export const BootScreen = ({
  title,
  description,
  tone = "loading",
  inPanel = false,
  children,
}: BootScreenProps) => (
  <main className={cn("grid place-items-center p-6", inPanel ? "flex-1" : "min-h-svh")}>
    <Empty className="max-w-md p-0">
      <EmptyHeader className="gap-2">
        <EmptyMedia
          className={cn("mb-1", tone === "error" ? "text-destructive" : "text-foreground")}
        >
          {tone === "loading" ? (
            <span role="status" aria-label="Loading">
              <UsineMark running className="block size-8" />
            </span>
          ) : (
            <WarningCircleIcon weight="fill" className="size-5" />
          )}
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

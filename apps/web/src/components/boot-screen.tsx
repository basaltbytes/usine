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

/** Full-viewport placeholder for the loading, unreachable, and not-found states shown before a screen can render. */
export const BootScreen = ({
  title,
  description,
  tone = "loading",
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly tone?: "loading" | "error";
  readonly children?: ReactNode;
}) => (
  <main className="grid min-h-svh place-items-center p-6">
    <Empty className="max-w-md">
      <EmptyHeader>
        <EmptyMedia variant="icon" className={cn(tone === "error" && "text-destructive")}>
          {tone === "loading" ? <Spinner /> : <WarningCircleIcon weight="fill" />}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="wrap-anywhere">{description}</EmptyDescription>
      </EmptyHeader>
      {children !== undefined && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  </main>
);

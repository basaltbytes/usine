import type { ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";

type EmptyListProps = {
  readonly title: string;
  readonly description: string;
  /** The list's create button, or a link to what must exist first; omitted when none applies. */
  readonly action?: ReactNode;
};

/** Renders a list page with no entries, in the dashed outline of an empty lane. */
export const EmptyList = ({ title, description, action }: EmptyListProps) => (
  <Empty variant="list" className="flex-none items-start justify-start text-left">
    <EmptyHeader spacing="compact" className="max-w-xl items-start">
      <EmptyTitle variant="list">{title}</EmptyTitle>
      <EmptyDescription variant="list">{description}</EmptyDescription>
    </EmptyHeader>
    {action !== undefined && (
      <EmptyContent className="max-w-none items-start empty:hidden">{action}</EmptyContent>
    )}
  </Empty>
);

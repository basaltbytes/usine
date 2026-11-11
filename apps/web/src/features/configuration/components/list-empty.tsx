import { type ReactNode, useContext } from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import {
  CreationContext,
  NewEntityButton,
} from "~/features/configuration/components/editor/create";

type ListEmptyProps = {
  readonly title: string;
  readonly description: string;
  /** Replaces the page's create button, for example with a link to a prerequisite. */
  readonly action?: ReactNode;
};

/** Renders a list page with no entries, in the dashed outline of an empty lane, and nothing while the creation form is open. */
export const ListEmpty = ({ title, description, action }: ListEmptyProps) => {
  const creation = useContext(CreationContext);
  if (creation?.creating === true) return null;
  return (
    <Empty className="flex-none items-start justify-start gap-3 rounded-lg border border-input px-5 py-5 text-left text-wrap">
      <EmptyHeader className="max-w-xl items-start gap-0.5">
        <EmptyTitle className="font-sans text-sm tracking-normal">{title}</EmptyTitle>
        <EmptyDescription className="text-sm text-pretty">{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-none items-start empty:hidden">
        {action ?? <NewEntityButton />}
      </EmptyContent>
    </Empty>
  );
};

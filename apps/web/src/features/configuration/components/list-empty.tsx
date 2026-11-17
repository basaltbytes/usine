import { type ReactNode, useContext } from "react";
import { EmptyList } from "~/components/empty-list";
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

/** Renders a configuration list with no entries, and nothing while the creation form is open. */
export const ListEmpty = ({ title, description, action }: ListEmptyProps) => {
  const creation = useContext(CreationContext);
  if (creation?.creating === true) return null;
  return (
    <EmptyList title={title} description={description} action={action ?? <NewEntityButton />} />
  );
};

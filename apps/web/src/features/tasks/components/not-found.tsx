import { useProjectLinks } from "~/hooks/use-project-links";
import { Link } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import { BootScreen } from "~/components/boot-screen";
import { Button } from "~/components/ui/button";
import { backToBoard, taskNotFound, taskNotFoundDescription } from "~/features/tasks/strings";

type TaskNotFoundProps = {
  readonly repository: RepositoryName;
  readonly number: string;
};

export const TaskNotFound = ({ repository, number }: TaskNotFoundProps) => {
  const projectLinks = useProjectLinks();
  return (
    <BootScreen
      title={taskNotFound}
      description={taskNotFoundDescription(repository, number)}
      tone="error"
      inPanel
    >
      <Button
        variant="outline"
        nativeButton={false}
        render={<Link {...projectLinks.board(repository)} />}
      >
        {backToBoard}
      </Button>
    </BootScreen>
  );
};

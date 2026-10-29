import { Link } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import { BootScreen } from "~/components/boot-screen";
import { Button } from "~/components/ui/button";
import { backToBoard, taskNotFound, taskNotFoundDescription } from "~/features/tasks/strings";
import { projectParams } from "~/lib/overview";

type TaskNotFoundProps = {
  readonly repository: RepositoryName;
  readonly number: string;
};

export const TaskNotFound = ({ repository, number }: TaskNotFoundProps) => (
  <BootScreen
    title={taskNotFound}
    description={taskNotFoundDescription(repository, number)}
    tone="error"
    inPanel
  >
    <Button
      variant="outline"
      nativeButton={false}
      render={<Link to="/projects/$project/$name" params={projectParams(repository)} />}
    >
      {backToBoard}
    </Button>
  </BootScreen>
);

import { Link } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import { BootScreen } from "~/components/boot-screen";
import { Button } from "~/components/ui/button";
import { projectParams } from "~/lib/overview";

type TaskNotFoundProps = {
  readonly repository: RepositoryName;
  readonly number: string;
};

export const TaskNotFound = ({ repository, number }: TaskNotFoundProps) => (
  <BootScreen
    title="Task not found"
    description={`#${number} is not among the newest items on the ${repository} board`}
    tone="error"
    inPanel
  >
    <Button
      variant="outline"
      nativeButton={false}
      render={<Link to="/projects/$owner/$name" params={projectParams(repository)} />}
    >
      Back to the board
    </Button>
  </BootScreen>
);

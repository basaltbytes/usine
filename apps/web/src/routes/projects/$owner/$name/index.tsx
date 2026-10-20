import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BootScreen } from "@/components/boot-screen";
import { Button } from "@/components/ui/button";
import { ProjectBoard } from "../../../../board/board.tsx";
import { deskQuery } from "../../../../desk/query.ts";
import { overviewQuery } from "../../../../overview.ts";
import { useOpenRun } from "../../../../open-run.ts";

const BoardRoute = () => {
  const { repository } = Route.useParams();
  const { data } = useSuspenseQuery(overviewQuery());
  const desk = useQuery(deskQuery());
  const openRun = useOpenRun();
  const project = data.projects.find((candidate) => candidate.repository === repository);
  // A live refetch can drop the project after the loader admitted it.
  if (project === undefined)
    return (
      <BootScreen
        title="Project not found"
        description="This repository is not registered with the running usine."
        tone="error"
      >
        <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
          Back to the desk
        </Button>
      </BootScreen>
    );
  return (
    <ProjectBoard
      project={project}
      loops={data.loops}
      stalled={desk.data?.notMoving ?? []}
      disabled={data._tag === "NeedsSetup"}
      openRun={openRun}
    />
  );
};

export const Route = createFileRoute("/projects/$owner/$name/")({ component: BoardRoute });

import { Link, useParams } from "@tanstack/react-router";
import { BootScreen } from "~/components/boot-screen";
import { Button } from "~/components/ui/button";

/** Renders the work panel content for a Project URL that matches no registered project. */
export const ProjectNotFound = () => {
  const { project } = useParams({ from: "/projects/$project" });
  return (
    <BootScreen
      title="Project not found"
      description={`No project has the ID ${project}. Admins manage projects in Configuration > Projects.`}
      tone="error"
      inPanel
    >
      <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
        Back to Overview
      </Button>
    </BootScreen>
  );
};

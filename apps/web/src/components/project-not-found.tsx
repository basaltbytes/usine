import { Link } from "@tanstack/react-router";
import { BootScreen } from "~/components/boot-screen";
import { Button } from "~/components/ui/button";

/** Renders the work panel content for a Project URL that matches no registered repository. */
export const ProjectNotFound = () => (
  <BootScreen
    title="Project not found"
    description="This repository is not under repos in usine.yaml."
    tone="error"
    inPanel
  >
    <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
      Back to Overview
    </Button>
  </BootScreen>
);

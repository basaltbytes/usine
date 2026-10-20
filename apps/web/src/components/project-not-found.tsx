import { Link } from "@tanstack/react-router";
import { BootScreen } from "@/components/boot-screen";
import { Button } from "@/components/ui/button";

/** Shown in the work panel for a Project address that names no registered repository. */
export const ProjectNotFound = () => (
  <BootScreen
    title="Project not found"
    description="This repository is not registered with the running usine."
    tone="error"
    inPanel
  >
    <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
      Back to Overview
    </Button>
  </BootScreen>
);

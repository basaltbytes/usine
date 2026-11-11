import { Link } from "@tanstack/react-router";
import { BootScreen } from "~/components/boot-screen";
import { Button } from "~/components/ui/button";

const manageProjects = "Admins manage projects in Configuration > Projects.";

/** Describes a Project URL whose project ID names no project. */
export const missingProjectDescription = (project: string): string =>
  `No project has the ID ${project}. ${manageProjects}`;

/** Describes a legacy repository URL whose repository belongs to no project. */
export const missingRepositoryDescription = (repository: string): string =>
  `No project includes the repository ${repository}. ${manageProjects}`;

/** Describes a URL under an existing project whose trailing segment names no page. */
export const missingPageDescription = (project: string, page: string): string =>
  `The project ${project} has no page ${page}.`;

/** Describes a run URL whose run does not belong to the project in the URL. */
export const runOutsideProjectDescription = (run: string, project: string): string =>
  `Run ${run} does not belong to the project ${project}. ${manageProjects}`;

/** Renders the work panel content for a URL that matches no registered project, with `description` naming what is missing. */
export const ProjectNotFound = ({
  title = "Project not found",
  description,
}: {
  readonly title?: string;
  readonly description: string;
}) => (
  <BootScreen title={title} description={description} tone="error" inPanel>
    <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
      Back to Overview
    </Button>
  </BootScreen>
);

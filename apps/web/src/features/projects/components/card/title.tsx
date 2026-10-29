import { useProjectLinks } from "~/hooks/use-project-links";
import type { ProjectId } from "@usine/core/project";
import { Link } from "@tanstack/react-router";
import type { BoardTaskView } from "@usine/orchestrator/operator";

import { taskNumber } from "~/lib/tasks/model";

// The title's click area covers the whole card, so clicking anywhere opens the Task page.
const titleClass =
  "block w-full cursor-pointer text-left outline-none after:absolute after:inset-0 after:rounded-lg";

type CardTitleProps = {
  readonly project?: ProjectId | undefined;
  readonly item: BoardTaskView;
};

/** Renders the title as a link to the Task page at the originating Item's number. */
export const CardTitle = ({ item, project }: CardTitleProps) => {
  const projectLinks = useProjectLinks();
  return (
    <h3 className="text-sm/snug font-medium text-card-foreground" title={item.title}>
      <Link
        {...(project === undefined
          ? {
              ...projectLinks.task(item.repository, taskNumber(item)),
            }
          : {
              to: "/projects/$project/tasks/$number",
              params: { project, number: taskNumber(item) },
              search: { repository: item.repository },
            })}
        draggable={false}
        className={titleClass}
      >
        <span className="line-clamp-2">{item.title}</span>
      </Link>
    </h3>
  );
};

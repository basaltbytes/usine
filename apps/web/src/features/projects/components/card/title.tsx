import { Link } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import type { BoardTaskView } from "@usine/orchestrator/operator";
import { projectParams } from "~/lib/overview";
import { taskNumber } from "~/lib/tasks/model";

// The title's click area covers the whole card, so clicking anywhere opens the Task page.
const titleClass =
  "block w-full cursor-pointer text-left outline-none after:absolute after:inset-0 after:rounded-lg";

type CardTitleProps = {
  readonly item: BoardTaskView;
  readonly repository: RepositoryName;
};

/** Renders the title as a link to the Task page at the originating Item's number. */
export const CardTitle = ({ item, repository }: CardTitleProps) => (
  <h3 className="text-sm/snug font-medium text-card-foreground" title={item.title}>
    <Link
      to="/projects/$owner/$name/tasks/$number"
      params={{ ...projectParams(repository), number: taskNumber(item) }}
      draggable={false}
      className={titleClass}
    >
      <span className="line-clamp-2">{item.title}</span>
    </Link>
  </h3>
);

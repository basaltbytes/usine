import { useQuery } from "@tanstack/react-query";
import { Link, linkOptions } from "@tanstack/react-router";
import type { ProjectId } from "@usine/core/project";
import { Option } from "effect";
import { type ComponentProps, type ReactNode, use } from "react";
import { LabelBadge } from "~/components/label-badge";
import { RunChip, TaskChip } from "~/components/references/chips";
import { ReferenceScopeContext } from "~/components/references/scope";
import { configurationQuery } from "~/lib/configuration/queries";
import { overviewQuery, projectId } from "~/lib/overview";
import {
  type ConfigurationKind,
  type ReferenceData,
  type ReferenceScope,
  referenceProject,
  resolveReference,
} from "~/lib/references/resolve";
import {
  decodeReferenceMark,
  type ReferencePlace,
  type Reference as WrittenReference,
} from "~/lib/references/syntax";
import { projectTasksQuery } from "~/lib/tasks/queries";

const configurationLink = (kind: ConfigurationKind, name: string) => {
  switch (kind) {
    case "loop":
      return linkOptions({ to: "/configuration/loops/$loop", params: { loop: name } });
    case "agent":
      return linkOptions({ to: "/configuration/agents/$agent", params: { agent: name } });
    case "worker":
      return linkOptions({ to: "/configuration/workers/$worker", params: { worker: name } });
  }
};

type ResolvedProps = {
  readonly reference: WrittenReference;
  readonly place: ReferencePlace;
  readonly data: ReferenceData;
  /** The reference as written: its text, or its code span. */
  readonly written: ReactNode;
};

const Resolved = ({ reference, place, data, written }: ResolvedProps) => {
  const resolution = resolveReference(reference, data);
  switch (resolution._tag) {
    case "Task":
      return (
        <TaskChip
          project={resolution.project}
          task={resolution.task}
          item={resolution.item}
          place={place}
        />
      );
    case "Run":
      return <RunChip project={resolution.project} run={resolution.run} />;
    case "RunPage":
      return (
        <Link
          {...linkOptions({
            to: "/projects/$project/runs/$run",
            params: { project: resolution.project, run: resolution.run },
          })}
        >
          {written}
        </Link>
      );
    case "Label":
      return <LabelBadge name={resolution.label.name} label={resolution.label} />;
    case "Configuration":
      return <Link {...configurationLink(resolution.kind, resolution.name)}>{written}</Link>;
    case "GitHub":
      return (
        <a href={resolution.url} target="_blank" rel="noopener noreferrer">
          {written}
        </a>
      );
    case "Text":
      return written;
  }
};

type BoardReferenceProps = ResolvedProps & { readonly project: ProjectId };

/** Resolves a reference with the full view of `project`, which the Tasks list reads too. */
const BoardReference = ({ project, data, ...props }: BoardReferenceProps) => {
  const { data: view } = useQuery(projectTasksQuery(project));
  // The query keeps the previous project's view while another loads.
  const board = view !== undefined && projectId(view) === project ? view : undefined;
  return <Resolved {...props} data={{ ...data, board }} />;
};

type ScopedReferenceProps = Omit<ResolvedProps, "data"> & { readonly scope: ReferenceScope };

const ScopedReference = ({ scope, ...props }: ScopedReferenceProps) => {
  const { reference } = props;
  const { data: overview } = useQuery(overviewQuery());
  const { data: configuration } = useQuery({
    ...configurationQuery(),
    enabled: reference._tag === "Name",
  });
  const project = referenceProject(reference, scope, overview?.projects ?? []);
  const data: ReferenceData = { scope, board: undefined, configuration };
  return project === undefined ? (
    <Resolved {...props} data={data} />
  ) : (
    <BoardReference {...props} project={project} data={data} />
  );
};

type ReferenceProps = ComponentProps<"data"> & { readonly node?: unknown };

/**
 * Renders a reference that `remarkReferences` marked: a task or a run as a chip, a label as its
 * badge, a source line or an item that the board doesn't show as a GitHub link, a run ID that the
 * board doesn't show as a link to its run page, and a loop, agent, or worker name as a link to its
 * configuration page. Anything else stays as written.
 */
export const Reference = ({ value, children }: ReferenceProps) => {
  const scope = use(ReferenceScopeContext);
  const mark = decodeReferenceMark(value);
  const written = Option.isSome(mark) && mark.value.code ? <code>{children}</code> : children;
  return scope === undefined || Option.isNone(mark) ? (
    written
  ) : (
    <ScopedReference
      scope={scope}
      reference={mark.value.reference}
      place={mark.value.place}
      written={written}
    />
  );
};

import { useQuery } from "@tanstack/react-query";
import type { RepositoryName } from "@usine/core/repository";
import { createContext, type ReactNode } from "react";
import { overviewQuery, projectForRepository, projectId } from "~/lib/overview";
import type { ReferenceScope } from "~/lib/references/resolve";

/** The scope of the usine text below it. `Markdown` links references only inside one. */
export const ReferenceScopeContext = createContext<ReferenceScope | undefined>(undefined);

type RepositoryReferencesProps = {
  readonly repository: RepositoryName;
  readonly children: ReactNode;
};

/**
 * Links the references in usine text about `repository`, such as a run's transcript: `#<number>`
 * in that repository, and the runs and labels of its project.
 */
export const RepositoryReferences = ({ repository, children }: RepositoryReferencesProps) => {
  const { data: overview } = useQuery(overviewQuery());
  const project = projectForRepository(overview?.projects ?? [], repository);
  return (
    <ReferenceScopeContext
      value={{
        project: project === undefined ? undefined : projectId(project),
        repository,
        sources: [],
      }}
    >
      {children}
    </ReferenceScopeContext>
  );
};

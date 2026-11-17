import { useQuery } from "@tanstack/react-query";
import { type AccessScope, InstanceScope, permits, ProjectScope } from "@usine/core/access";
import { TurnMember } from "@usine/core/conversation";
import { instanceScope, readOnlyNote } from "~/lib/conversations/strings";
import { overviewQuery, projectId, projectName } from "~/lib/overview";
import { sessionQuery, usePermissions } from "~/lib/permissions";

/** Returns the name of a conversation's scope: the project's display name, or the instance. */
export const useScopeName = (scope: AccessScope): string => {
  const project = scope._tag === "Project" ? scope.project : undefined;
  const { data } = useQuery({
    ...overviewQuery(),
    select: (overview) => overview.projects.find((entry) => projectId(entry) === project),
  });
  if (scope._tag === "Instance") return instanceScope;
  return data === undefined ? scope.project : projectName(data);
};

/** A scope the member can start a conversation in, as the scope picker lists it. */
export type ScopeChoice = {
  readonly value: string;
  readonly label: string;
  readonly scope: AccessScope;
};

/** The value of the instance in the scope picker; project IDs are kebab-case, so none is equal. */
export const INSTANCE_CHOICE = "instance";

/** Returns the scopes the member can operate on: the instance, then each project. */
export const useScopeChoices = (): ReadonlyArray<ScopeChoice> => {
  const grants = usePermissions();
  const { data: projects = [] } = useQuery({
    ...overviewQuery(),
    select: (overview) => overview.projects,
  });
  const instance = InstanceScope.make();
  return [
    ...(permits(grants, "operate", instance)
      ? [{ value: INSTANCE_CHOICE, label: instanceScope, scope: instance }]
      : []),
    ...projects.flatMap((project) => {
      const scope = ProjectScope.make({ project: projectId(project) });
      return permits(grants, "operate", scope)
        ? [{ value: projectId(project), label: projectName(project), scope }]
        : [];
    }),
  ];
};

/** Returns the signed-in member, or `undefined` for a credential without one. */
export const useMember = (): TurnMember | undefined => {
  const { data } = useQuery({ ...sessionQuery(), select: (session) => session.member });
  return data === undefined || data === null ? undefined : TurnMember.make(data);
};

/**
 * Returns why the signed-in member can't post in `scope`, or `undefined` when they can: posting
 * needs a member and operate access on the scope.
 */
export const useReadOnlyReason = (scope: AccessScope): string | undefined => {
  const grants = usePermissions();
  const member = useMember();
  const name = useScopeName(scope);
  return member !== undefined && permits(grants, "operate", scope) ? undefined : readOnlyNote(name);
};

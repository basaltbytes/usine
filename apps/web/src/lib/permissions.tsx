import type { RepositoryName } from "@usine/core/repository";
import { overviewQuery, projectForRepository } from "./overview";
import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  PermissionGrant,
  InstanceScope,
  ProjectScope,
  permits,
  type Permission,
} from "@usine/core/access";
import { ProjectId } from "@usine/core/project";
import { Option, Schema } from "effect";
import { createContext, useContext } from "react";
import { authRequest } from "./auth";

export const sessionQuery = () =>
  queryOptions({
    queryKey: ["auth-session"],
    queryFn: () =>
      authRequest(
        "/api/auth/session",
        Schema.Struct({ permissions: Schema.Array(PermissionGrant) }),
      ),
    staleTime: 60_000,
    meta: { refreshLabel: "Session" },
  });
export const PermissionsContext = createContext<ReadonlyArray<PermissionGrant>>([]);
export const canReadOverview = (grants: ReadonlyArray<PermissionGrant>) =>
  grants.some(({ permission }) => permission === "read" || permission === "admin");
export const usePermissions = () => useContext(PermissionsContext);
export const useCan = (permission: Permission, project?: string) => {
  const grants = usePermissions();
  const parsed = Schema.decodeUnknownOption(ProjectId)(project);
  return permits(
    grants,
    permission,
    Option.match(parsed, {
      onNone: () => new InstanceScope(),
      onSome: (project) => new ProjectScope({ project }),
    }),
  );
};
export const useCanOperateLoop = (loop: string) =>
  useCan("operate", loop.includes("/") ? loop.split("/")[0] : undefined);

export const useCanOperateRepository = (repository: RepositoryName) => {
  const permissions = usePermissions();
  const { data } = useQuery({
    ...overviewQuery(),
    enabled: canReadOverview(permissions) && !permits(permissions, "admin", new InstanceScope()),
  });
  return useCan("operate", projectForRepository(data?.projects ?? [], repository)?.id);
};

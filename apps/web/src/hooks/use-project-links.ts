import { useQuery } from "@tanstack/react-query";
import { linkOptions } from "@tanstack/react-router";
import type { RepositoryName } from "@usine/core/repository";
import type { RunId } from "@usine/core/run";
import { overviewQuery, projectParams } from "~/lib/overview";

export const useProjectLinks = () => {
  const { data } = useQuery(overviewQuery());
  const paramsFor = (repository: RepositoryName) => projectParams(data?.projects ?? [], repository);
  return {
    board: (repository: RepositoryName) => {
      const params = paramsFor(repository);
      return params === undefined
        ? linkOptions({ to: "/" })
        : linkOptions({ to: "/projects/$project", params });
    },
    task: (repository: RepositoryName, number: string) => {
      const params = paramsFor(repository);
      return params === undefined
        ? linkOptions({ to: "/" })
        : linkOptions({
            to: "/projects/$project/tasks/$number",
            params: { ...params, number },
            search: { repository },
          });
    },
    run: (repository: RepositoryName, run: RunId) => {
      const params = paramsFor(repository);
      return params === undefined
        ? linkOptions({ to: "/" })
        : linkOptions({ to: "/projects/$project/runs/$run", params: { ...params, run } });
    },
  };
};

import { addRepository } from "~/features/configuration/strings";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { RepositoryRow } from "~/features/configuration/components/repositories/row";
import { ConfigurationPage, Missing } from "~/features/configuration/components/section";

type RepositoriesListProps = {
  readonly configuration: ConfigurationView;
};

export const RepositoriesList = ({ configuration }: RepositoriesListProps) => (
  <ConfigurationPage
    title="Repositories"
    createKind="repository"
    counts={`${configuration.repositories.length} ${configuration.repositories.length === 1 ? "repository" : "repositories"}`}
  >
    {configuration.repositories.length === 0 ? (
      <Missing title="No repositories registered">{addRepository}</Missing>
    ) : (
      <div className="@container -mx-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Repository</TableHead>
              <TableHead className="hidden @2xl:table-cell">Tags</TableHead>
              <TableHead className="text-right">Lanes</TableHead>
              <TableHead>Labels</TableHead>
              <TableHead className="hidden sm:table-cell">Loops</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configuration.repositories.map((repository) => (
              <RepositoryRow key={repository.name} repository={repository} />
            ))}
          </TableBody>
        </Table>
      </div>
    )}
  </ConfigurationPage>
);

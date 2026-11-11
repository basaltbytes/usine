import { emptyListCopy } from "~/features/configuration/strings";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { RepositoryRow } from "~/features/configuration/components/repositories/row";
import { ListEmpty } from "~/features/configuration/components/list-empty";
import { ConfigurationPage } from "~/features/configuration/components/section";

type RepositoriesListProps = {
  readonly configuration: ConfigurationView;
};

export const RepositoriesList = ({ configuration }: RepositoriesListProps) => (
  <ConfigurationPage
    title="Repositories"
    createKind="repository"
    empty={configuration.repositories.length === 0}
    counts={
      configuration.repositories.length === 1
        ? "1 repository"
        : `${configuration.repositories.length} repositories`
    }
  >
    {configuration.repositories.length === 0 ? (
      <ListEmpty {...emptyListCopy.repository} />
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

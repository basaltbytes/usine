import { Link } from "@tanstack/react-router";
import { type RepositoryName, splitRepositoryName } from "@usine/core/repository";
import { RepositoryMark } from "~/components/repository-mark";

type RepositoryLinkProps = { readonly repository: RepositoryName };

export const RepositoryLink = ({ repository }: RepositoryLinkProps) => {
  const { owner, name } = splitRepositoryName(repository);
  return (
    <Link
      to="/configuration/repositories/$owner/$name"
      params={{ owner, name }}
      className="flex w-fit items-center gap-2 text-primary hover:underline"
    >
      <RepositoryMark repository={repository} />
      {repository}
    </Link>
  );
};

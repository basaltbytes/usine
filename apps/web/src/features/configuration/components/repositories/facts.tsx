import { Link } from "@tanstack/react-router";
import type { RepositoryConfigurationView } from "@usine/orchestrator/operator";
import { Fact, Facts, Unset } from "~/features/configuration/components/section";
import { projectParams } from "~/lib/overview";

type RepositoryFactsProps = { readonly repository: RepositoryConfigurationView };

export const RepositoryFacts = ({ repository }: RepositoryFactsProps) => (
  <Facts>
    <Fact label="Board">
      <Link
        to="/projects/$owner/$name"
        params={projectParams(repository.name)}
        className="text-primary hover:underline"
      >
        Open the board
      </Link>
    </Fact>
    <Fact label="Tags">
      {repository.tags.length === 0 ? <Unset>None</Unset> : repository.tags.join(", ")}
    </Fact>
    <Fact label="Loops">
      {repository.loops.length === 0 ? (
        <Unset>Not selected by any loop</Unset>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {repository.loops.map((loop) => (
            <li key={loop}>
              <Link
                to="/configuration/loops/$loop"
                params={{ loop }}
                className="text-primary hover:underline"
              >
                {loop}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Fact>
  </Facts>
);

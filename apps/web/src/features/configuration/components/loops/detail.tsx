import { entityKey } from "~/features/configuration/lib/entities";
import { Link } from "@tanstack/react-router";
import type { ConfigurationView } from "@usine/orchestrator/operator";
import { FileError } from "~/features/configuration/components/file-error";
import { LoadedLoop } from "~/features/configuration/components/loops/loaded";
import { type PauseLoop } from "~/features/configuration/components/loops/list";
import { ConfigurationPage, Missing, NotLoaded } from "~/features/configuration/components/section";

type LoopDetailProps = {
  readonly name: string;
  readonly configuration: ConfigurationView;
  readonly pause: PauseLoop | null;
};

/** `name` is the Loop file name without `.md`. */
export const LoopDetail = ({ name, configuration, pause }: LoopDetailProps) => {
  const loop = configuration.loops.find((candidate) => candidate.name === name);
  if (loop !== undefined)
    return <LoadedLoop loop={loop} configuration={configuration} pause={pause} />;
  const quarantined = configuration.quarantinedLoops.find((candidate) => candidate.name === name);
  if (quarantined !== undefined)
    return (
      <ConfigurationPage
        entity={entityKey("loop", name)}
        title={quarantined.name}
        marks={<NotLoaded />}
        file={quarantined.file}
      >
        <FileError error={quarantined.error} consequence="No runs until the file loads." />
      </ConfigurationPage>
    );
  return (
    <ConfigurationPage entity={entityKey("loop", name)} title={name}>
      <Missing title="Loop not found">
        The configuration has no file <code>loops/{name}.md</code>.{" "}
        <Link to="/configuration/loops" className="text-primary hover:underline">
          See all loops
        </Link>
        .
      </Missing>
    </ConfigurationPage>
  );
};

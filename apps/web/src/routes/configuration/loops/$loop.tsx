import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useLoopPause } from "~/features/configuration/configuration.page";
import { LoopDetail } from "~/features/configuration/components/loops/detail";
import { configurationQuery } from "~/features/configuration/queries";

const Loop = () => {
  const { loop } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  return <LoopDetail name={loop} configuration={data} pause={useLoopPause()} />;
};

export const Route = createFileRoute("/configuration/loops/$loop")({ component: Loop });

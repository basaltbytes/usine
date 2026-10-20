import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useLoopPause } from "../../../configuration/layout.tsx";
import { LoopDetail } from "../../../configuration/loops.tsx";
import { configurationQuery } from "../../../configuration/query.ts";

const Loop = () => {
  const { loop } = Route.useParams();
  const { data } = useSuspenseQuery(configurationQuery());
  return <LoopDetail name={loop} configuration={data} pause={useLoopPause()} />;
};

export const Route = createFileRoute("/configuration/loops/$loop")({ component: Loop });

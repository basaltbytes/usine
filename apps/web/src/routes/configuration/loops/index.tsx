import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useLoopPause } from "../../../configuration/layout.tsx";
import { LoopsList } from "../../../configuration/loops.tsx";
import { configurationQuery } from "../../../configuration/query.ts";

const Loops = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <LoopsList configuration={data} pause={useLoopPause()} />;
};

export const Route = createFileRoute("/configuration/loops/")({ component: Loops });

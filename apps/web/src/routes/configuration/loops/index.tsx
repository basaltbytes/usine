import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useLoopPause } from "~/features/configuration/configuration.page";
import { LoopsList } from "~/features/configuration/components/loops";
import { configurationQuery } from "~/features/configuration/queries";

const Loops = () => {
  const { data } = useSuspenseQuery(configurationQuery());
  return <LoopsList configuration={data} pause={useLoopPause()} />;
};

export const Route = createFileRoute("/configuration/loops/")({ component: Loops });

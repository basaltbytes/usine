import { createFileRoute } from "@tanstack/react-router";
import { Desk } from "~/features/overview/overview.page";

export const Route = createFileRoute("/")({ component: Desk });

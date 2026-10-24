import { createFileRoute } from "@tanstack/react-router";
import { Desk } from "../desk/desk.tsx";

export const Route = createFileRoute("/")({ component: Desk });

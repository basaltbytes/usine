import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

/** Returns an in-memory router that renders `component` at `path` and at every other URL. */
export const memoryRouter = (component: () => ReactNode, path = "/") =>
  createRouter({
    routeTree: createRootRoute({ component }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });

type WithRouterProps = { readonly children: ReactNode };

/** Provides a router to `children` without rendering routes, so links render as static markup. */
export const WithRouter = ({ children }: WithRouterProps) => {
  const [router] = useState(() => memoryRouter(() => null));
  return <RouterContextProvider router={router}>{children}</RouterContextProvider>;
};

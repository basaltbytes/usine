import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

/** A router whose one route renders `component` at `path` and any other address; its links resolve
 * and navigate in memory. */
export const memoryRouter = (component: () => ReactNode, path = "/") =>
  createRouter({
    routeTree: createRootRoute({ component }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });

/** Gives `children` a router without rendering routes, so their links render as static markup. */
export const WithRouter = ({ children }: { readonly children: ReactNode }) => {
  const [router] = useState(() => memoryRouter(() => null));
  return <RouterContextProvider router={router}>{children}</RouterContextProvider>;
};

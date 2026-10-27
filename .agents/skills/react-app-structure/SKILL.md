---
name: react-app-structure
description: File placement, naming, imports, props, data loading, and tests in a React app with TanStack file routes (apps/web). Use when adding a route, page, component, hook, helper, query, or UI string, when moving or splitting web files, when writing a web test, or when naming a route group, feature folder, or component folder.
---

# React app structure

`src/` has five top-level folders. Every file belongs to exactly one.

| Folder | Holds |
|---|---|
| `routes/` | TanStack file routes. The framework owns this layout. |
| `features/<feature>/` | Everything one feature owns: `components/`, `hooks/`, `utils/`, `lib/`, `queries.ts`, `strings.ts`, page files, and tests. |
| `components/` | Reusable UI only. The root holds pieces any screen uses (`ui/` registry, marks, badges). `components/<feature>/` holds reusable pieces of one feature. |
| `hooks/` | App-wide hooks. |
| `lib/` | App-wide helpers and clients. |

Import direction: `routes/` imports `features/`, `features/` imports `components/`, `hooks/`, and `lib/`, and a feature never imports another feature's files. A lint rule enforces the direction.

## Routes

- The route's component lives in the route file, defined above `Route`.
- A page too large for its route file moves to `features/<feature>/<name>.page.tsx` (`features/tasks/list.page.tsx`), and the route file imports it. `.page.tsx` marks every page file; nothing else uses the suffix.
- A route file holds the route, its loader, and its component. Queries, strings, and sub-components belong to the feature.
- Search params are parsed once, by `validateSearch` on the route that owns them. Components read them with `Route.useSearch()`.

## Features

- One feature per route group, with the same word everywhere: route `tasks/`, folder `features/tasks/`, folder `components/tasks/`.
- A feature folder holds `components/`, `hooks/`, `utils/`, `lib/`, `queries.ts`, `strings.ts`, page files, and tests. Create a subfolder once it has a file.
- A piece that two features use is reusable. It moves to `components/`, `hooks/`, or `lib/` at the root.

## Data

- `features/<feature>/queries.ts` exports one `queryOptions` factory per query. The query key is written there and nowhere else.
- The route's `loader` calls `context.queryClient.ensureQueryData(...)` with those options, so data is ready before the first render and links prefetch on hover.
- Components read the same options with `useSuspenseQuery`. A component never builds a query key or calls `useQuery` with an inline key.

## Strings

- Text shown to the user lives in `features/<feature>/strings.ts` as named exports; a component imports the string it renders.
- Strings shared by several features go in `lib/strings.ts`.

## Imports

- Import app files through the `~/` alias (`~/components/ui/button`, `~/lib/api`). Relative paths are for files in the same folder.
- `~/` is the only alias. `tsconfig.json` paths, the Vite alias, and the `aliases` block of `components.json` all spell it, so `shadcn add` emits it too.
- Named exports only. The one default export is a route's `createFileRoute` result, which the generator requires as `Route`.

## Components

- A component's props are a named type, `<Component>Props`, declared above the component: `DashboardProps` for `Dashboard`.
- Declare it with `type`, never `interface`, and mark fields `readonly`.
- A component file stays under 300 lines. Past that, the next sub-component moves to `components/<name>.tsx` in the same feature.
- Vendored registry files under `components/ui/` and `components/ai-elements/` keep upstream's shape.

## Tests

- A test sits beside the file it covers: `moves.ts` has `moves.test.ts`, and a component rendered in Chromium has `card.browser.test.tsx`.
- `vitest.config.ts` picks tests up from `src/**` by those suffixes; no `test/` folder.
- Pure modules (`utils/`, `lib/`, `queries.ts` selectors) get unit tests. Browser tests cover behaviour the DOM decides, such as drag, scroll, and focus.

## Placement check

Name the feature before you create a file. A file with no feature is app-wide and goes in `components/`, `hooks/`, or `lib/`. A file with a feature goes under `features/<feature>/`, or under `components/<feature>/` when other features render it.

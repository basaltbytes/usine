---
name: react-app-structure
description: Where a file goes, what it exports, and how it loads data in apps/web. Use before creating, moving, or splitting a file under apps/web/src, writing a component, adding a query, or writing a web test.
---

# React app structure

`src/` has five top-level folders.

| Folder | Holds |
|---|---|
| `routes/` | TanStack file routes. |
| `features/<feature>/` | Everything one feature owns. |
| `components/` | Reusable UI. The root holds pieces any screen uses; `components/<feature>/` holds pieces of one feature that other features render. |
| `hooks/` | App-wide hooks. |
| `lib/` | App-wide helpers and clients. |

Imports flow one way: `routes/` to `features/`, and `features/` to `components/`, `hooks/`, and `lib/`. A feature imports only root folders.

## Placement

Name the file's feature first. With a feature, the file goes under `features/<feature>/`; rendered by other features too, under `components/<feature>/`. Without one, it goes in `components/`, `hooks/`, or `lib/`.

A feature is named after its route group, and that one name is used everywhere: route `tasks/`, `features/tasks/`, `components/tasks/`. Inside a feature: `components/`, `hooks/`, `utils/`, `lib/`, `queries.ts`, `strings.ts`, page files, and tests.

## Routes

- A route file holds `Route`, its loader, and its component, defined above `Route`.
- A page too large for its route file moves to `features/<feature>/<name>.page.tsx` and the route imports it. `.page.tsx` marks a page file and nothing else.
- Search params are parsed once, by `validateSearch` on the route that owns them, and read with `Route.useSearch()`.

## Data

- `features/<feature>/queries.ts` exports one `queryOptions` factory per query. The query key is written there and nowhere else.
- The route's `loader` calls `ensureQueryData` with those options; components read them with `useSuspenseQuery`.

## Strings

Text shown to the user is a named export of `features/<feature>/strings.ts`, or `lib/strings.ts` when several features show it.

## Imports

- `~/` is the only alias, for every file outside the importer's folder. `components.json` spells it too, so `shadcn add` emits it.
- Named exports only.

## Components

- Props are a named type declared above the component: `type DashboardProps = { readonly ... }` for `Dashboard`.
- A component file stays under 300 lines. Past that, the next sub-component moves to its own file under the feature's `components/`.
- Vendored files under `components/ui/` and `components/ai-elements/` keep upstream's shape.

## Tests

- A test sits beside the file it covers: `moves.test.ts` next to `moves.ts`, `card.browser.test.tsx` next to `card.tsx`.
- Pure modules get unit tests. Browser tests cover what the DOM decides: drag, scroll, focus.

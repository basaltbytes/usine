# create-usine

Create an instance folder with an exact-pinned `@usine/server` installation. Requires Node.js 22 or later.

```sh
npm create usine@latest my-factory
cd my-factory
npm run usine -- up
```

With pnpm:

```sh
pnpm create usine my-factory
cd my-factory
pnpm usine up
```

The destination must be new or empty. The command writes `package.json`, `.gitignore`, and a mode-0600 `.env` template, then runs the invoking package manager's install command to create its lockfile and `node_modules/`. Direct invocation defaults to npm. If installation fails, run `npm install` or `pnpm install` in the destination to retry.

The first `usine up` creates an empty configuration revision and opens GitHub App setup. Configuration and credentials are saved under `.usine/`. `.gitignore` excludes that directory, `.env`, and `node_modules/`. Keep the instance folder on persistent storage and include its runtime data in backups.

Use `npm run usine -- up --detach` or `pnpm usine up --detach` to run in the background. Run the local CLI with the same package manager for `status`, `stop`, `restart`, and `sign-in-link`. See [Run a factory](https://docs.usine.dev/guides/) for setup and [the CLI reference](https://docs.usine.dev/reference/configuration/cli/) for lifecycle commands.

## Releases

Changesets releases `create-usine` and `@usine/server` together. The build copies the server's release version into the published artifact; the scaffold uses that exact version, including the prerelease suffix for `create-usine@next`. The release workflow publishes this public package with npm provenance, using the same trusted-publisher configuration as the other packages.

## Validation

After `pnpm build`, `pnpm --filter create-usine test` runs the compiled CLI in temporary folders. A process fixture substitutes the registry install and links the built server; the startup test runs that server, checks setup mode and the stored revision, then stops it. `pnpm check:packed-install` checks installation of the published package contents with npm.

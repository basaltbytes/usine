import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, it } from "vitest";
import { build, esmExternalRequirePlugin } from "vite";

it("renders bundled command output containing ANSI colors and literal markup", async () => {
  // Vitest's SSR loader unwraps CommonJS differently from Vite's browser build.
  // Render the shipped module so an invalid ANSI component export cannot hide.
  const result = await build({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    plugins: [
      esmExternalRequirePlugin({
        external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
      }),
    ],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(
          new URL("../src/components/ai-elements/terminal.tsx", import.meta.url),
        ),
        formats: ["es"],
      },
      rolldownOptions: {
        output: { paths: (name) => import.meta.resolve(name) },
      },
    },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  assert.isDefined(bundle);
  assert.ok("output" in bundle);
  const entry = bundle.output.filter((file) => file.type === "chunk").find((file) => file.isEntry);
  assert.isDefined(entry, "Vite produced no terminal entry module");
  const { Terminal } = await import(
    `data:text/javascript;base64,${Buffer.from(`${entry.code}\n//# sourceURL=terminal.browser.mjs`).toString("base64")}`
  );
  const html = renderToStaticMarkup(
    <Terminal
      title="Test output"
      output={"\u001b[32mPassed\u001b[0m\n<script>literal output</script>"}
    />,
  );

  assert.include(html, "Test output");
  assert.include(html, "Passed");
  assert.include(html, "&lt;script&gt;literal output&lt;/script&gt;");
  assert.include(html, 'aria-label="Copy output"');
  assert.notInclude(html, "\u001b[");
  // The production build shares CI CPUs with the monorepo suites.
}, 30_000);

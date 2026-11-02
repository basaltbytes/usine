// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import lucode from "lucode-starlight";
import starlightLinksValidator from "starlight-links-validator";
import { redirects } from "./redirects.mjs";

export default defineConfig({
  site: "https://docs.usine.dev",
  redirects,
  integrations: [
    mermaid({
      autoTheme: true,
      enableLog: false,
      mermaidConfig: {
        fontFamily: "var(--sl-font, var(--sl-font-system))",
        themeVariables: { fontFamily: "var(--sl-font, var(--sl-font-system))" },
        layout: "dagre",
        look: "classic",
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false, width: 120, actorMargin: 30 },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
      },
    }),
    starlight({
      title: "usine",
      logo: { dark: "./src/assets/logo-dark.svg", light: "./src/assets/logo-light.svg" },
      customCss: ["./src/styles/diagrams.css", "./src/styles/sidebar.css"],
      description:
        "usine runs coding agents on the GitHub issues and pull requests of the repositories an operator registers.",
      plugins: [
        lucode({
          navLinks: [
            { label: "Get started", link: "/get-started/" },
            { label: "Guides", link: "/guides/overview/" },
            { label: "Reference", link: "/reference/" },
            { label: "GitHub", link: "https://github.com/basaltbytes/usine" },
          ],
          footerText:
            "usine is licensed under AGPL-3.0. The source is on [GitHub](https://github.com/basaltbytes/usine).",
        }),
        starlightLinksValidator(),
      ],
      sidebar: [
        {
          label: "Get started",
          items: [
            { label: "Overview", slug: "get-started" },
            { label: "Quickstart", slug: "get-started/quickstart" },
            { label: "Concepts", slug: "get-started/concepts" },
          ],
        },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "reference/cli" },
            {
              label: "Configuration",
              items: [
                { label: "usine.yaml", slug: "reference/configuration/usine-yaml" },
                { label: "Settings", link: "/reference/configuration/usine-yaml/#settings" },
                { label: "Projects", link: "/reference/configuration/usine-yaml/#projects" },
                { label: "Workers", link: "/reference/configuration/usine-yaml/#workers" },
                { label: "Loops", slug: "reference/configuration/loop-files" },
                { label: "Agents", slug: "reference/configuration/agent-files" },
                { label: "Expressions", slug: "reference/configuration/expressions" },
                { label: "Configuration revisions", slug: "reference/configuration/config" },
              ],
            },
            { label: "Operator HTTP API", slug: "reference/operator-api" },
          ],
        },
      ],
    }),
  ],
});

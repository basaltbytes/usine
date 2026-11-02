// @ts-check
import starlight from "@astrojs/starlight";
import { unified } from "@astrojs/markdown-remark";
import { defineConfig } from "astro/config";
import lucode from "lucode-starlight";
import starlightLinksValidator from "starlight-links-validator";
import { redirects } from "./redirects.mjs";
import rehypePele from "./diagrams/rehype.mjs";

export default defineConfig({
  site: "https://docs.usine.dev",
  redirects,
  markdown: {
    processor: unified({ rehypePlugins: [rehypePele] }),
    syntaxHighlight: { type: "shiki", excludeLangs: ["mermaid"] },
  },
  integrations: [
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
                { label: "Settings", slug: "reference/configuration/settings" },
                { label: "Projects and registry", slug: "reference/configuration/projects" },
                { label: "Workers", slug: "reference/configuration/workers" },
                { label: "Loops", slug: "reference/configuration/loops" },
                { label: "Agents", slug: "reference/configuration/agents" },
                { label: "Expressions", slug: "reference/configuration/expressions" },
                { label: "Configuration revisions", slug: "reference/configuration/config" },
                {
                  label: "Import and export format",
                  slug: "reference/configuration/import-export",
                },
              ],
            },
            { label: "Access", slug: "reference/access" },
            { label: "Operator HTTP API", slug: "reference/operator-api" },
          ],
        },
      ],
    }),
  ],
});

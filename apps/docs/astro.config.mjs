// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import lucode from "lucode-starlight";
import starlightLinksValidator from "starlight-links-validator";
import { apiReference, apiSidebarGroup } from "./api-reference.mjs";

export default defineConfig({
  site: "https://docs.usine.dev",
  integrations: [
    mermaid({
      autoTheme: true,
      enableLog: false,
      mermaidConfig: {
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false, width: 120, actorMargin: 30 },
        state: { useMaxWidth: false },
        er: { useMaxWidth: false },
      },
    }),
    starlight({
      title: "usine",
      customCss: ["./src/styles/diagrams.css"],
      description:
        "usine runs coding agents on the GitHub issues and pull requests of the repositories an operator registers.",
      plugins: [
        lucode({
          navLinks: [
            { label: "Guides", link: "/guides/" },
            { label: "Architecture", link: "/architecture/" },
            { label: "Reference", link: "/reference/" },
            { label: "GitHub", link: "https://github.com/basaltbytes/usine" },
          ],
          footerText:
            "usine is MIT licensed. The source is on [GitHub](https://github.com/basaltbytes/usine).",
        }),
        apiReference,
        starlightLinksValidator(),
      ],
      sidebar: [
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Architecture", items: [{ autogenerate: { directory: "architecture" } }] },
        {
          label: "Reference",
          items: [
            { label: "Overview", slug: "reference" },
            {
              label: "Configuration",
              items: [{ autogenerate: { directory: "reference/configuration" } }],
            },
            apiSidebarGroup,
          ],
        },
      ],
    }),
  ],
});

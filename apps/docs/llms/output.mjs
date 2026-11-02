// @ts-check
import { readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { fromHtml } from "hast-util-from-html";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";

export const pageSeparator = "\n\n<!-- llms-page -->\n\n";

/**
 * @param {string} site
 * @returns {import("astro").AstroIntegration}
 */
export function llmsOutput(site) {
  return {
    name: "usine-llms-output",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const overview = fromHtml(await readFile(new URL("get-started/index.html", dir), "utf8"));
        /** @type {Set<string>} */
        const links = new Set();
        visit(overview, "element", (node) => {
          if (node.tagName !== "sl-sidebar-state-persist") return;
          visit(node, "element", (link) => {
            if (link.tagName === "a") {
              links.add(Schema.decodeUnknownSync(Schema.String)(link.properties.href));
            }
          });
        });
        if (links.size === 0) throw new Error("The docs sidebar contains no pages for llms.txt.");

        const pages = await Promise.all(
          [...links].map(async (href) => {
            const html = fromHtml(await readFile(new URL(`.${href}index.html`, dir), "utf8"));
            let title = "";
            visit(html, "element", (node) => {
              if (node.tagName === "h1") title = toString(node);
            });
            return { href, title };
          }),
        );

        const indexUrl = new URL("llms.txt", dir);
        const index = await readFile(indexUrl, "utf8");
        const header = index.split("\n\n").slice(0, 2).join("\n\n");
        await writeFile(
          indexUrl,
          `${index}\n## Pages\n\n${pages.map(({ href, title }) => `- [${title}](${new URL(href, site)})`).join("\n")}\n`,
        );

        for (const filename of ["llms-full.txt", "llms-small.txt"]) {
          const url = new URL(filename, dir);
          const sections = (await readFile(url, "utf8")).split(pageSeparator);
          const ordered = pages.map(({ title, href }) => {
            const matches = sections.filter((section) => section.startsWith(`# ${title}\n`));
            if (matches.length !== 1) {
              throw new Error(
                `${filename}: expected one section for ${href}, got ${matches.length}.`,
              );
            }
            return matches[0];
          });
          await writeFile(url, `${header}\n\n${ordered.join("\n\n")}\n`);
        }
        logger.info(
          `Published llms.txt, llms-full.txt, and llms-small.txt with ${pages.length} pages.`,
        );
      },
    },
  };
}

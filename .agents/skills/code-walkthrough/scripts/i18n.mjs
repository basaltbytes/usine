/* code-walkthrough — chrome string tables (the fixed UI text the builder emits).
   Authored content (section prose, summaries) is whatever language you write it
   in; this only translates the GitHub-style chrome.

   Pick a table with `lang: "fr"` in the content model, override single keys with
   `strings: { viewOnGitHub: "…" }`. Add a language by copying `en` to a new key
   and translating — keep the same shape. Composite entries are functions so word
   order can differ per language. */

export const STRINGS = {
  en: {
    locale: "en-US",
    stateOpen: "Open",
    stateMerged: "Merged",
    stateDraft: "Draft",
    stateClosed: "Closed",
    viewOnGitHub: "View on GitHub",
    filesChangedWord: "files changed",
    removed: "Removed",
    translations: "Translations",
    potTemplate: "template",
    tests: "Tests",
    showSource: "show source ▾",
    hide: "hide ▴",
    /** entry-count chips in the i18n widget */
    eNew: (n) => `${n} new`,
    eUpdated: (n) => `${n} updated`,
    eRemoved: (n) => `${n} removed`,
    /** @param {number} langs language count @param {number} entries touched entry count */
    i18nMeta: (langs, entries) =>
      `${langs} language${langs === 1 ? "" : "s"}${entries ? ` · ${entries} entries touched` : ""}`,
    /** @param {number} n test count */
    testsMeta: (n) => `${n} test${n === 1 ? "" : "s"}`,
    /** @param {string} author bolded author HTML @param {number} c commit count @param {string} base ref-span HTML @param {string} head ref-span HTML */
    wantsToMerge: (author, c, base, head) =>
      `${author} wants to merge <b>${c} commit${c === 1 ? "" : "s"}</b> into ${base} from ${head}`,
    /** @param {string} n files @param {string} add additions (formatted) @param {string} del deletions (formatted) */
    filesHeader: (n, add, del) =>
      `Showing <b style="color:var(--txt-dim)">${n} changed files</b> with <b style="color:var(--new)">${add} additions</b> and <b style="color:var(--txt-dim)">${del} deletions</b>.`,
  },

  fr: {
    locale: "fr-FR",
    stateOpen: "Ouverte",
    stateMerged: "Fusionnée",
    stateDraft: "Brouillon",
    stateClosed: "Fermée",
    viewOnGitHub: "Voir sur GitHub",
    filesChangedWord: "fichiers modifiés",
    removed: "Supprimés",
    translations: "Traductions",
    potTemplate: "modèle",
    tests: "Tests",
    showSource: "voir la source ▾",
    hide: "masquer ▴",
    eNew: (n) => `${n} nouvelles`,
    eUpdated: (n) => `${n} mises à jour`,
    eRemoved: (n) => `${n} supprimées`,
    i18nMeta: (langs, entries) =>
      `${langs} langue${langs === 1 ? "" : "s"}${entries ? ` · ${entries} entrées modifiées` : ""}`,
    testsMeta: (n) => `${n} test${n === 1 ? "" : "s"}`,
    wantsToMerge: (author, c, base, head) =>
      `${author} souhaite fusionner <b>${c} commit${c === 1 ? "" : "s"}</b> dans ${base} depuis ${head}`,
    filesHeader: (n, add, del) =>
      `Affichage de <b style="color:var(--txt-dim)">${n} fichiers modifiés</b> avec <b style="color:var(--new)">${add} ajouts</b> et <b style="color:var(--txt-dim)">${del} suppressions</b>.`,
  },
};

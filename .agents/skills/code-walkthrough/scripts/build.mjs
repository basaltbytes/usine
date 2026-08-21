#!/usr/bin/env node
/* ============================================================
   code-walkthrough builder.
   Usage:  node build.mjs <content.json> <out.html>

   Deterministic renderer: takes a content model + the bundled
   assets (octicons sprite, css, js) and emits ONE self-contained
   GitHub-styled HTML walkthrough. The chrome is identical every
   run; only the content model changes. See REFERENCE.md for the
   content schema and the block catalog.
   ============================================================ */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { STRINGS } from "./i18n.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, "..", "assets");

/* ---- Prism CDN (pinned + SRI) ---------------------------------- */
const PRISM = {
  css: {
    href: "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css",
    sri: "sha384-wFjoQjtV1y5jVHbt0p35Ui8aV8GVpEZkyF99OXWqP/eNJDU93D3Ugxkoyh6Y2I4A",
  },
  js: [
    ["components/prism-core.min.js", "sha384-MXybTpajaBV0AkcBaCPT4KIvo0FzoCiWXgcihYsw4FUkEz0Pv3JGV6tk2G8vJtDc"],
    ["components/prism-markup.min.js", "sha384-HkMr0bZB9kBW4iVtXn6nd35kO/L/dQtkkUBkL9swzTEDMdIe5ExJChVDSnC79aNA"],
    ["components/prism-css.min.js", "sha384-0mV13Neu0xhJFylI+HV43C+XiR13bGSeL7D0/7e6hK7sJgvyvK6HVjeQwmvXTstY"],
    ["components/prism-clike.min.js", "sha384-7LHwxHIDSHTBleLmgDWZbC/IMJsfYfFVOihKhvsrxYW4j47YQcRwZja4ToFE3bA8"],
    ["components/prism-javascript.min.js", "sha384-D44bgYYKvaiDh4cOGlj1dbSDpSctn2FSUj118HZGmZEShZcO2v//Q5vvhNy206pp"],
    ["components/prism-scss.min.js", "sha384-kRWiSF1UhVO7HGkpK3GX+OGmVHxBjCBwRxc9EIP3tqScIgDEAizIeCWds1M6ratq"],
    ["components/prism-python.min.js", "sha384-WJdEkJKrbsqw0evQ4GB6mlsKe5cGTxBOw4KAEIa52ZLB7DDpliGkwdme/HMa5n1m"],
  ],
  base: "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/",
};

/* ---- helpers --------------------------------------------------- */
const esc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
const oc = (name, cls = "") =>
  `<svg class="octicon${cls ? " " + cls : ""}"><use href="#oct-${esc(name)}"/></svg>`;
const changeColor = (c) => (c === "new" ? "oc-added" : c === "mod" ? "oc-mod" : "oc-mut");
const EDGE_CLS = { new: "e-new", derived: "e-derived", ctx: "e-ctx" };
const NODE_CLS = { new: "t-new", mod: "t-mod", ctx: "t-ctx" };

/* ---- block renderers ------------------------------------------- */
function renderBlock(b, ctx) {
  switch (b.c) {
    case "intro":
      return `<p class="sec-intro">${b.html}</p>`;
    case "p":
      return `<p>${b.html}</p>`;
    case "h3":
      return `<h3>${esc(b.text)}</h3>`;
    case "html":
      return b.html;
    case "callout":
      return `<div class="callout${b.tone ? " " + b.tone : ""}">${b.html}</div>`;
    case "attrs":
      return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 16px">${b.items
        .map((t) => `<span class="tag">${esc(t)}</span>`)
        .join("")}</div>`;
    case "flow":
      return `<div class="flow">${b.steps
        .map((s, i) => `<span class="step">${s}</span>${i < b.steps.length - 1 ? '<span class="arr">→</span>' : ""}`)
        .join("")}</div>`;
    case "fields":
      return renderFields(b);
    case "methods":
      return renderMethods(b);
    case "code":
      return renderCode(b, ctx);
    case "table":
      return renderTable(b);
    case "matrix":
      return renderMatrix(b);
    case "cards":
      return renderCards(b);
    case "concepts":
      return renderConcepts(b);
    case "patterns":
      return renderPatterns(b);
    case "removed":
      return renderRemoved(b, ctx);
    case "i18n":
      return renderI18n(b, ctx);
    case "tests":
      return renderTests(b, ctx);
    case "diagram":
      return renderDiagram(b, ctx);
    case "files":
      return renderFiles(ctx.content, ctx.t);
    default:
      throw new Error(`Unknown block type: ${b.c}`);
  }
}

/* Generic name/kind/note table. Headers default to Field/Type/Meaning but
   `headers: [a,b,c]` overrides all three (e.g. Name/Kind/Note for JS props). */
function renderFields(b) {
  const heads = b.headers || ["Field", "Type", b.noteHead || "Meaning"];
  const rows = b.rows
    .map((r) => {
      const badges = (r.badges || [])
        .map((x) => `<span class="badge ${x.cls || "ro"}">${esc(x.label)}</span>`)
        .join(" ");
      return `<tr><td class="fname">${esc(r.name)}</td><td class="ftype">${esc(r.type)}</td><td class="fnote">${r.note || ""}${badges ? " " + badges : ""}</td></tr>`;
    })
    .join("\n");
  return `<table class="tbl"><thead><tr><th>${esc(heads[0])}</th><th>${esc(heads[1])}</th><th>${esc(heads[2])}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMethods(b) {
  return b.items
    .map(
      (m) =>
        `<div class="method">${m.decorator ? `<span class="deco">${esc(m.decorator)}</span>` : ""}<span class="sig">${esc(m.sig)}</span><p>${m.html}</p></div>`
    )
    .join("\n");
}

function renderCode(b, ctx) {
  const collapsed = b.collapsed === false ? "" : " collapsed";
  const toggle = b.collapsed === false ? ctx.t.hide : ctx.t.showSource;
  const lang = b.lang || "python";
  return `<div class="codeblock${collapsed}">
  <div class="cbar"><span class="fpath">${esc(b.path || "")}</span><span class="ctoggle">${toggle}</span></div>
  <pre><code class="language-${esc(lang)}">${esc(b.code)}</code></pre>
</div>`;
}

function renderTable(b) {
  const head = `<thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>`;
  const body = b.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, i) => (i === 0 && b.firstColMono ? `<td class="fname">${cell}</td>` : `<td>${cell}</td>`))
          .join("")}</tr>`
    )
    .join("\n");
  return `<table class="tbl">${head}<tbody>${body}</tbody></table>`;
}

function renderMatrix(b) {
  const head = `<thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>`;
  const body = b.rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n");
  return `<table class="matrix">${head}<tbody>${body}</tbody></table>`;
}

function renderCards(b) {
  const cls = b.cols === 3 ? "grid3" : "grid2";
  const items = b.items
    .map((c) => `<div class="card">${c.title ? `<h3 style="margin-top:0">${c.title}</h3>` : ""}${c.html}</div>`)
    .join("\n");
  return `<div class="${cls}">${items}</div>`;
}

function renderConcepts(b) {
  const items = b.items
    .map(
      (c) =>
        `<div class="concept"><div class="ico">${c.icon || "✦"}</div><h4>${c.title}</h4><p>${c.html}</p></div>`
    )
    .join("\n");
  return `<div class="grid3">${items}</div>`;
}

/* GitHub-native list of transferable techniques (octicons, not emoji cards) */
function renderPatterns(b) {
  const head = b.title ? `<div class="bxhead">${oc("light-bulb")}${esc(b.title)}</div>` : "";
  const rows = b.items
    .map(
      (p) =>
        `<div class="pattern-row">${oc(p.icon || "dot-fill")}<div class="pt"><b>${p.term}</b> — <span class="ex">${p.html}</span>${
          p.ref ? ` <code>${esc(p.ref)}</code>` : ""
        }</div></div>`
    )
    .join("\n");
  return `<div class="gh-box">${head}${rows}</div>`;
}

/* deleted files, surfaced first-class for refactor PRs */
function renderRemoved(b, ctx) {
  const head = `<div class="bxhead">${oc("diff-removed")}${esc(b.title || ctx.t.removed)}</div>`;
  const rows = b.items
    .map((it) => {
      const { name } = splitPath(it.path);
      const why = it.why ? `<span class="why">— ${it.why}</span>` : "";
      const del = it.del != null ? `<span class="dels">−${it.del}</span>` : "";
      return `<div class="removed-row">${oc("file")}<span class="path">${esc(name)}</span>${why}${del}</div>`;
    })
    .join("\n");
  return `<div class="gh-box removed">${head}${rows}</div>`;
}

/* translations widget — one row per .po/.pot file, counts instead of diffs */
function renderI18n(b, ctx) {
  const t = ctx.t;
  const langRows = b.rows.filter((r) => r.lang);
  const langs = langRows.length;
  // count real translations, not the .pot template — fall back to it on template-only PRs
  const touched = (langRows.length ? langRows : b.rows).reduce(
    (n, r) => n + ((r.entries?.new || 0) + (r.entries?.updated || 0) + (r.entries?.removed || 0)),
    0
  );
  const head = `<div class="bxhead">${oc("globe")}${esc(b.title || t.translations)}<span class="bxmeta">${esc(
    t.i18nMeta(langs, touched)
  )}</span></div>`;
  const rows = b.rows
    .map((r) => {
      const [icon, color] = CHIP_ICON[r.status] || CHIP_ICON.M;
      const { dir, name } = splitPath(r.path);
      const tag = r.lang
        ? `<span class="langtag">${esc(r.lang).toUpperCase()}</span>`
        : `<span class="langtag pot">${esc(t.potTemplate)}</span>`;
      const e = r.entries || {};
      const counts =
        e.new || e.updated || e.removed
          ? `<span class="i18n-counts">${e.new ? `<span class="c-new">+${esc(t.eNew(e.new))}</span>` : ""}${
              e.updated ? `<span class="c-upd">~${esc(t.eUpdated(e.updated))}</span>` : ""
            }${e.removed ? `<span class="c-rem">−${esc(t.eRemoved(e.removed))}</span>` : ""}</span>`
          : "";
      const note = r.note ? `<span class="why">— ${r.note}</span>` : "";
      const ds =
        r.add != null || r.del != null
          ? `<span class="ds"><span class="adds">+${r.add || 0}</span> <span class="dels">−${r.del || 0}</span><span class="bar">${diffSquares(r.add, r.del)}</span></span>`
          : "";
      return `<div class="i18n-row">${oc(icon, color)}${tag}${dir ? `<span class="dir">${esc(dir)}</span>` : ""}<span class="path">${esc(name)}</span>${counts}${note}${ds}</div>`;
    })
    .join("\n");
  const foot = b.note ? `<div class="bxfoot">${b.note}</div>` : "";
  return `${b.intro ? `<p class="sec-intro">${b.intro}</p>` : ""}<div class="gh-box i18n">${head}${rows}${foot}</div>`;
}

/* tests widget — TLDR cards (scenario + key assertions), never the full diff */
function renderTests(b, ctx) {
  const t = ctx.t;
  const head = `<div class="bxhead">${oc("beaker")}${esc(b.title || t.tests)}<span class="bxmeta">${esc(
    t.testsMeta(b.items.length)
  )}</span></div>`;
  const rows = b.items
    .map((it) => {
      const badge = it.kind ? `<span class="badge ctx">${esc(it.kind)}</span>` : "";
      const ref = it.ref ? `<code class="tref">${esc(it.ref)}</code>` : "";
      const asserts =
        it.asserts && it.asserts.length
          ? `<ul class="asserts">${it.asserts.map((a) => `<li>${oc("check-circle-fill")}<span>${a}</span></li>`).join("")}</ul>`
          : "";
      const code = it.code ? renderCode({ ...it.code, collapsed: it.code.collapsed ?? true }, ctx) : "";
      return `<div class="test-row"><div class="thead"><span class="sig">${esc(it.name)}</span>${badge}${ref}</div><p class="scenario">${it.scenario}</p>${asserts}${code}</div>`;
    })
    .join("\n");
  return `${b.intro ? `<p class="sec-intro">${b.intro}</p>` : ""}<div class="gh-box tests">${head}${rows}</div>`;
}

/* file-status icon + mini diff bar (shared by files list + section chips) */
const CHIP_ICON = { A: ["file-added", "oc-added"], M: ["file-diff", "oc-mod"], D: ["file", "oc-del"] };
function splitPath(p) {
  const i = p.lastIndexOf("/");
  return { dir: i >= 0 ? p.slice(0, i + 1) : "", name: i >= 0 ? p.slice(i + 1) : p };
}
function diffSquares(add, del) {
  const total = (add || 0) + (del || 0);
  if (!total) return "<i></i><i></i><i></i><i></i><i></i>";
  let g = Math.round((5 * (add || 0)) / total);
  if (add > 0 && g === 0) g = 1;
  if (del > 0 && g === 5) g = 4;
  return '<i class="g"></i>'.repeat(g) + '<i class="r"></i>'.repeat(5 - g);
}
function renderFileChips(files) {
  if (!files || !files.length) return "";
  const chips = files
    .map((f) => {
      const [icon, color] = CHIP_ICON[f.status] || CHIP_ICON.M;
      const { dir, name } = splitPath(f.path);
      return `<span class="filechip">${oc(icon, color)}${dir ? `<span class="dir">${esc(dir)}</span>` : ""}${esc(name)}</span>`;
    })
    .join("");
  return `<div class="section-files">${chips}</div>`;
}

function renderDiagram(b, ctx) {
  const nodes = b.nodes
    .map((n) => {
      const head =
        `<div class="nhead"><span class="mname">${esc(n.model)}</span>` +
        (n.badge
          ? `<span class="badge ${n.badge.cls}">${esc(n.badge.label)}</span>`
          : n.nlabel
            ? `<span class="nlabel">${esc(n.nlabel)}</span>`
            : "") +
        `</div>`;
      const body = (n.compartments || [])
        .map(
          (cp) =>
            `<div class="compart">${esc(cp.label)}</div>` +
            (cp.rows || []).map((r) => `<div class="row">${r}</div>`).join("")
        )
        .join("");
      return `<div class="node ${NODE_CLS[n.change] || "t-ctx"}" id="${escAttr(n.id)}"${
        n.target ? ` data-target="${escAttr(n.target)}"` : ""
      } style="grid-column:${n.col};grid-row:${n.row};">${head}<div class="nbody">${body}</div></div>`;
    })
    .join("\n");

  // edges → window var (read by walkthrough.js)
  ctx.edges = b.edges.map((e) => ({
    from: e.from,
    to: e.to,
    cls: EDGE_CLS[e.kind] || "e-ctx",
    label: e.label || "",
    thick: !!e.thick,
  }));

  const legend = `<div class="legend">
    <span class="li"><span class="sw box" style="border-color:var(--new)"></span> new model / field</span>
    <span class="li"><span class="sw box" style="border-color:var(--mod)"></span> modified</span>
    <span class="li"><span class="sw box" style="border-color:var(--ctx);border-style:dashed"></span> context</span>
    <span class="li"><span class="sw" style="border-color:var(--accent);border-top-style:dashed"></span> derived (SQL view)</span>
    <span class="li"><span class="sw" style="border-color:var(--new)"></span> new relation</span>
    <span class="li"><span class="sw" style="border-color:var(--ctx)"></span> existing relation</span>
  </div>`;

  return `${b.intro ? `<p class="sec-intro">${b.intro}</p>` : ""}
<div class="diagram-wrap">
  <div class="diagram" id="diagram">
    <svg class="edges" id="edges">
      <defs>
        <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L7,3 L0,6 Z" fill="currentColor"/>
        </marker>
      </defs>
    </svg>
    ${nodes}
  </div>
  ${legend}
  ${b.hint ? `<div class="hint">${b.hint}</div>` : ""}
</div>`;
}

/* ---- files-changed list ---------------------------------------- */
const ROW_ICON = { A: ["diff-added", "oc-added"], M: ["diff-modified", "oc-mod"], D: ["diff-removed", "oc-del"] };
function renderFiles(content, t) {
  const s = content.pr.stats || {};
  const head = `<div class="fhead">${oc("file-diff", "oc-mut")}<span>${t.filesHeader(
    s.filesChanged ?? content.files.length,
    (s.additions ?? 0).toLocaleString(t.locale),
    (s.deletions ?? 0).toLocaleString(t.locale)
  )}</span></div>`;
  const rows = content.files
    .map((f) => {
      const [icon, color] = ROW_ICON[f.status] || ROW_ICON.M;
      const { dir, name } = splitPath(f.path);
      const counts =
        f.add != null || f.del != null
          ? `<span class="ds"><span class="adds">+${f.add || 0}</span> <span class="dels">−${f.del || 0}</span><span class="bar">${diffSquares(
              f.add,
              f.del
            )}</span></span>`
          : "";
      const inner = `${oc(icon, color)}${dir ? `<span class="dir">${esc(dir)}</span>` : ""}<span class="path">${esc(name)}</span>${counts}`;
      return f.href
        ? `<a class="gh-frow" href="${escAttr(f.href)}">${inner}</a>`
        : `<div class="gh-frow">${inner}</div>`;
    })
    .join("\n");
  return `<div class="gh-files">${head}${rows}</div>`;
}

/* ---- sidebar --------------------------------------------------- */
function renderSidebar(content) {
  const pr = content.pr;
  const brand = `<div class="brand">
      ${oc("git-pull-request", "lg")}
      <div>
        <b style="display:block;font-size:13px;line-height:1.25">${esc(pr.title)}</b>
        <span style="font-size:11.5px;color:var(--txt-mut)">#${esc(pr.number)}${pr.module ? " · " + esc(pr.module) : ""}</span>
      </div>
    </div>`;
  // override the PR icon color to the open-green via inline style on the lg octicon
  const brandFixed = brand.replace(
    'class="octicon lg"',
    'class="octicon lg" style="color:var(--open);margin-top:1px"'
  );

  let out = "";
  let lastGroup = null;
  for (const sec of content.sections) {
    const nav = sec.nav;
    if (!nav) continue;
    if (nav.group !== lastGroup) {
      out += `\n    <div class="grp">${esc(nav.group)}</div>`;
      lastGroup = nav.group;
    }
    if (nav.file) {
      const statusCls = nav.status === "A" ? "added" : nav.status === "D" ? "del" : "mod";
      const icon = nav.status === "A" ? "file-added" : "file-diff";
      out += `\n    <a class="nav file ${statusCls}" href="#${esc(sec.id)}">${oc(icon)}${esc(nav.label)}</a>`;
    } else {
      out += `\n    <a class="nav" href="#${esc(sec.id)}">${oc(nav.icon || "dot-fill")}${esc(nav.label)}</a>`;
    }
  }
  return `  <nav class="side">\n    ${brandFixed}\n${out}\n  </nav>`;
}

/* ---- main: PR header + hero + sections -------------------------- */
function statePill(state, t) {
  const labels = { open: t.stateOpen, merged: t.stateMerged, draft: t.stateDraft, closed: t.stateClosed };
  const bg = { open: "var(--open)", merged: "#8957e5", draft: "var(--txt-mut)", closed: "var(--danger)" };
  const label = labels[state] || labels.open;
  const cls = state === "merged" ? "gh-state merged" : "gh-state";
  const style = state === "merged" || state === "open" ? "" : ` style="background:${bg[state] || bg.open}"`;
  return `<span class="${cls}"${style}>${oc("git-pull-request")}${label}</span>`;
}

function renderHeader(content, t) {
  const pr = content.pr;
  const num = pr.url
    ? `<a class="num" href="${escAttr(pr.url)}" target="_blank" rel="noopener">#${esc(pr.number)}</a>`
    : `<span class="num">#${esc(pr.number)}</span>`;
  const ghLink = pr.url
    ? `<a class="gh-link" href="${escAttr(pr.url)}" target="_blank" rel="noopener">${oc("link-external", "sm")}${esc(t.viewOnGitHub)}</a>`
    : "";
  const merge =
    pr.author && pr.baseRef && pr.headRef
      ? `<span>${t.wantsToMerge(
          `<b>${esc(pr.author)}</b>`,
          pr.commits || 1,
          `<span class="ref">${esc(pr.baseRef)}</span>`,
          `<span class="ref">${esc(pr.headRef)}</span>`
        )}</span>`
      : "";

  const head = `<div class="pr-head">
        <h1 class="pr-title">${esc(pr.title)} ${num}</h1>
        <div class="pr-meta">
          ${statePill(pr.state || "open", t)}
          ${merge}
          ${ghLink}
        </div>
      </div>`;

  // hero: summary + diffstat
  const s = pr.stats || {};
  const add = s.additions ?? 0;
  const del = s.deletions ?? 0;
  const green = Math.max(1, Math.min(5, Math.round((5 * add) / (add + del || 1))));
  const squares =
    Array.from({ length: green }, () => '<i class="sq g"></i>').join("") +
    Array.from({ length: 5 - green }, () => '<i class="sq r"></i>').join("");
  const extra = (s.extra || []).map((x) => `<span style="color:var(--line)">·</span> ${esc(x)}`).join(" ");
  const hero = `<div class="hero">
        <p class="lead">${pr.summaryHtml || ""}</p>
        <div class="diffstat" style="margin-top:16px">
          ${oc("file-diff", "oc-mut")}
          <b style="color:var(--txt)">${s.filesChanged ?? content.files.length}</b> ${esc(t.filesChangedWord)}
          <span style="color:var(--line)">·</span>
          <span class="add">+${add.toLocaleString(t.locale)}</span><span class="del">−${del.toLocaleString(t.locale)}</span>
          <span class="squares">${squares}</span>
          ${extra}
        </div>
      </div>`;

  const highlights =
    pr.highlights && pr.highlights.length
      ? `<div class="grid3">${pr.highlights
          .map((h) => `<div class="concept"><div class="ico">${h.icon}</div><h4>${h.title}</h4><p>${h.html}</p></div>`)
          .join("")}</div>`
      : "";

  return `${head}\n\n      ${hero}\n\n      ${highlights}`;
}

function renderSection(sec, ctx) {
  const h = sec.heading;
  let heading = "";
  if (h) {
    const icon = oc(h.icon || "dot-fill", "lg " + changeColor(h.change));
    const badge = h.badge
      ? ` <span class="badge ${h.badge.cls}">${h.badge.octicon ? oc(h.badge.octicon, "sm") : ""}${esc(h.badge.label)}</span>`
      : "";
    heading = `<h2>${icon} ${h.title}${badge}</h2>`;
  }
  const chips = renderFileChips(sec.files);
  const body = (sec.blocks || []).map((b) => renderBlock(b, ctx)).join("\n      ");
  return `    <section id="${esc(sec.id)}">\n      ${heading}\n      ${chips}\n      ${body}\n    </section>`;
}

/* ---- document -------------------------------------------------- */
function build(content) {
  const css = readFileSync(join(ASSETS, "walkthrough.css"), "utf8");
  const sprite = readFileSync(join(ASSETS, "octicons-sprite.html"), "utf8");
  const js = readFileSync(join(ASSETS, "walkthrough.js"), "utf8");

  // chrome strings: English base ← language preset ← per-walkthrough overrides
  const lang = content.lang || "en";
  const t = { ...STRINGS.en, ...STRINGS[lang], ...content.strings };

  const ctx = { content, edges: [], t };
  const overview = content.sections.find((s) => s.id === "overview");
  const sectionsHtml = content.sections
    .filter((s) => s.id !== "overview")
    .map((s) => renderSection(s, ctx))
    .join("\n\n");

  // overview section wraps the PR header/hero + any extra blocks
  const overviewBlocks = overview ? (overview.blocks || []).map((b) => renderBlock(b, ctx)).join("\n      ") : "";
  const overviewHtml = `    <section id="overview">\n      ${renderHeader(content, t)}\n      ${overviewBlocks}\n    </section>`;

  const prismScripts = PRISM.js
    .map(([p, sri]) => `<script src="${PRISM.base}${p}" integrity="${sri}" crossorigin="anonymous"></script>`)
    .join("\n");

  const footer = content.footerHtml
    ? `<footer>${content.footerHtml}</footer>`
    : `<footer>Generated walkthrough of ${esc(content.pr.title)} (#${esc(content.pr.number)}).</footer>`;

  // only the two client-side strings the runtime needs (functions don't serialize)
  const clientStrings = { showSource: t.showSource, hide: t.hide };

  return `<!DOCTYPE html>
<html lang="${escAttr(lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(content.pr.title)} (#${esc(content.pr.number)}) · Code Walkthrough</title>
<link href="${PRISM.css.href}" rel="stylesheet" integrity="${PRISM.css.sri}" crossorigin="anonymous" />
<style>
${css}
</style>
</head>
<body>
${sprite}
<div class="shell">
${renderSidebar(content)}
  <main>
${overviewHtml}

${sectionsHtml}

    ${footer}
  </main>
</div>
${prismScripts}
<script>window.WALKTHROUGH = ${JSON.stringify({ edges: ctx.edges, strings: clientStrings })};</script>
<script>
${js}
</script>
</body>
</html>
`;
}

/* ---- cli ------------------------------------------------------- */
const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("Usage: node build.mjs <content.json|content.mjs> <out.html>");
  process.exit(2);
}
// JSON for simple content; .mjs/.js module (default export) when code blocks
// are easier to author with template literals.
let content;
if (/\.(mjs|js)$/.test(inPath)) {
  content = (await import(pathToFileURL(resolve(inPath)).href)).default;
} else {
  content = JSON.parse(readFileSync(resolve(inPath), "utf8"));
}
const html = build(content);
writeFileSync(resolve(outPath), html);
console.error(`✓ wrote ${outPath} (${html.length.toLocaleString("en-US")} bytes, ${content.sections.length} sections)`);

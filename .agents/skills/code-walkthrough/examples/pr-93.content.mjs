/* code-walkthrough content for PR #93 — the frontend / OWL exemplar
   (native Odoo view type, MVC split). Companion to pr-96 (backend).
   Build:  node ../scripts/build.mjs examples/pr-93.content.mjs examples/pr-93.html */

const R = String.raw;

export default {
  pr: {
    number: 93,
    title: "Rebuild opportunity pre-planning as a native Odoo view",
    state: "merged",
    url: "https://github.com/acme-co/planning-suite/pull/93",
    author: "octocat",
    baseRef: "dev",
    headRef: "feature/preplanning-native-odoo-view",
    commits: 1,
    module: "acme_planning",
    summaryHtml: R`Rebuilds the opportunity pre-planning macro screen from a hand-rolled
      <code>ir.actions.client</code> into a <b>native Odoo view type</b> (<code>preplanning_macro</code>)
      over <code>planning.allocation</code>, split MVC-style across an ArchParser, Model, Controller, and
      Renderer. The Controller wraps the Renderer in Odoo's <code>Layout</code>, so the breadcrumb, control
      panel, and <code>SearchBar</code> come for free; filters arrive as a domain from a <code>&lt;search&gt;</code>
      arch. Decision in <b>ADR-0007</b>.`,
    stats: {
      filesChanged: 22,
      additions: 2418,
      deletions: 2306,
      extra: ["client action → native view type", "MVC split", "grouping locked"],
    },
    highlights: [
      { icon: "🪟", title: "Native view type", html: R`<code>type="preplanning_macro"</code> registered in the <code>views</code> registry + server-side on <code>ir.ui.view</code>. Standard chrome, not a client action.` },
      { icon: "🔒", title: "Grouping is locked", html: R`<code>searchMenuTypes</code> omits <code>groupBy</code> and the search arch defines none, so the Opportunity → Role → Person hierarchy can't be reshaped from the UI.` },
      { icon: "🧩", title: "MVC split", html: R`The 1,300-line monolith becomes ArchParser · Model · Controller · Renderer — data loading and RPCs in the Model, grid in the Renderer.` },
    ],
  },

  files: [
    { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_model.js", href: "#m-model", add: 446, del: 0 },
    { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_renderer.js", href: "#m-renderer", add: 920, del: 0 },
    { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_renderer.xml", href: "#m-renderer", add: 261, del: 0 },
    { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_controller.js", href: "#m-controller", add: 123, del: 0 },
    { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_controller.xml", href: "#m-controller", add: 87, del: 0 },
    { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_arch_parser.js", href: "#m-archparser", add: 35, del: 0 },
    { status: "A", path: "addons/acme_planning/models/ir_ui_view.py", href: "#m-backend", add: 28, del: 0 },
    { status: "M", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_view.js", href: "#m-view", add: 51, del: 1352 },
    { status: "M", path: "addons/acme_planning/views/planning_allocation_views.xml", href: "#views", add: 54, del: 0 },
    { status: "M", path: "addons/acme_planning/views/acme_planning_views.xml", href: "#views", add: 5, del: 2 },
    { status: "M", path: "addons/acme_planning/models/__init__.py", add: 1, del: 0 },
    { status: "M", path: "addons/acme_planning/__manifest__.py", add: 7, del: 3 },
    { status: "M", path: "addons/acme_planning/static/tests/preplanning_macro_view.test.js", href: "#files", add: 110, del: 129 },
    { status: "M", path: "addons/acme_planning/tests/test_planning_allocation.py", add: 12, del: 2 },
    { status: "M", path: "addons/acme_planning/readme/DESCRIPTION.md", add: 10, del: 5 },
    { status: "M", path: "addons/acme_planning/readme/USAGE.md", add: 19, del: 15 },
    { status: "M", path: "addons/acme_planning/readme/HISTORY.md", add: 8, del: 0 },
    { status: "M", path: "addons/acme_planning/i18n/fr.po", add: 86, del: 85 },
    { status: "M", path: "addons/acme_planning/i18n/acme_planning.pot", add: 72, del: 86 },
    { status: "A", path: "docs/adr/0007-pre-planning-macro-native-view-type.md", href: "#mental-model", add: 83, del: 0 },
    { status: "D", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_filters.js", add: 0, del: 261 },
    { status: "D", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_view.xml", add: 0, del: 366 },
  ],

  sections: [
    { id: "overview", nav: { label: "Overview", icon: "list-unordered", group: "Orientation" }, blocks: [] },

    /* ---- why ---- */
    {
      id: "mental-model",
      nav: { label: "Why this PR exists", icon: "git-compare", group: "Orientation" },
      heading: { icon: "git-compare", title: "Why this PR exists" },
      files: [{ status: "A", path: "docs/adr/0007-pre-planning-macro-native-view-type.md" }],
      blocks: [
        { c: "intro", html: R`Reviewing this with a queue behind you? It's a re-chassis, not new behaviour. Here's the shape.` },
        { c: "p", html: R`A manager opens <i>Opportunity pre-planning</i> to see who's loaded across the year. The screen
          already worked — editable month grid, capacity badges, “To assign” rows — but it was an
          <code>ir.actions.client</code>: it drew its own <code>&lt;select&gt;</code> filter bar, fetched its own data, and
          had no breadcrumb, no control panel, no search facets. Next to every other backend view, it looked foreign.` },
        { c: "callout", tone: "key", html: R`This PR keeps the grid pixel-for-pixel and swaps the chassis underneath: the screen becomes a
          <b>native Odoo view type</b> (<code>preplanning_macro</code>) over <code>planning.allocation</code>. The breadcrumb,
          control panel, and search bar are now Odoo's own; filters come from a <code>&lt;search&gt;</code> arch and reach the
          Model as a domain. The bespoke filter module is deleted. (ADR-0007.)` },
        { c: "h3", text: "The one thing to check the rest of the diff against" },
        { c: "p", html: R`The screen is split into the four parts every Odoo view has: an <b>ArchParser</b> (reads the field list),
          a <b>Model</b> (loads data, owns RPCs and the year/unit/overloads state), a <b>Controller</b> (wraps everything in
          <code>Layout</code> and owns the toolbar), and a <b>Renderer</b> (the grid). If you've reviewed <code>web_planning_view</code>,
          this is the same chassis — that's the point of the rebuild, and the reason 1,352 lines of <code>view.js</code> melt
          into a 51-line descriptor.` },
        { c: "p", html: R`One deliberate constraint: <b>grouping is locked</b>. The descriptor's <code>searchMenuTypes</code> omits
          <code>groupBy</code> and the search arch defines no group-by filters, so a user can't reshape Opportunity → Role →
          Person or break the grid. The year, days/hours unit, and “overloads only” lens stay in a view toolbar — overloads is
          capacity-derived, not a stored field, so it can't be a domain filter.` },
        { c: "flow", steps: ["ir.actions.client", "→ act_window", "preplanning_macro view", "Layout + SearchBar", "domain → Model", "same grid"] },
        { c: "h3", text: "What it deliberately doesn't do" },
        { c: "p", html: R`No behaviour change to the grid, the editing, or the capacity maths — those move across unchanged.
          And no CSS/mobile polish: sticky first columns, horizontal scroll, and the small-screen stacked mode are a separate
          follow-up PR.` },
      ],
    },

    /* ---- diagram ---- */
    {
      id: "map",
      nav: { label: "Component map", icon: "git-branch", group: "Orientation" },
      heading: { icon: "git-branch", title: "Component map" },
      blocks: [
        {
          c: "diagram",
          intro: R`Not models this time — the MVC pieces of a native Odoo view. <b>Click a box</b> to jump to its file.
            The thick arrow is the whole point: the Controller borrows Odoo's <code>Layout</code> for standard chrome.`,
          hint: R`↳ <b>ir.actions.act_window</b> opens the <b>view descriptor</b>, which wires ArchParser · Model · Controller · Renderer. The backend <code>ir.ui.view</code> change just teaches Odoo the new type exists.`,
          nodes: [
            { id: "n-action", model: "ir.actions.act_window", change: "mod", badge: { cls: "mod", label: "was client" }, target: "#views", col: 1, row: 1,
              compartments: [{ label: "acme_planning_views.xml", rows: [R`<span class="k">view_mode = preplanning_macro</span>`] }] },
            { id: "n-backend", model: "ir.ui.view", change: "new", badge: { cls: "new", label: "py" }, target: "#m-backend", col: 3, row: 1,
              compartments: [{ label: "ir_ui_view.py", rows: [R`<span class="k">type</span> selection_add`, R`<span class="k">_get_view_info</span>`] }] },
            { id: "n-view", model: "preplanningMacroView", change: "mod", badge: { cls: "mod", label: "descriptor" }, target: "#m-view", col: 2, row: 2,
              compartments: [
                { label: "view.js · views registry", rows: [R`<span class="k">searchMenuTypes</span> = filter, favorite`] },
                { label: "wires", rows: [R`<span class="k">ArchParser · Model · Controller · Renderer</span>`] },
              ] },
            { id: "n-controller", model: "Controller", change: "new", badge: { cls: "new", label: "new" }, target: "#m-controller", col: 1, row: 3,
              compartments: [{ label: "controller.js", rows: [R`<span class="k">Layout · SearchBar</span>`, R`year · unit · overloads toolbar`] }] },
            { id: "n-model", model: "Model", change: "new", badge: { cls: "new", label: "new" }, target: "#m-model", col: 2, row: 3,
              compartments: [{ label: "model.js", rows: [R`<span class="k">load(searchParams)</span>`, R`year + domain → searchRead`] }] },
            { id: "n-renderer", model: "Renderer", change: "new", badge: { cls: "new", label: "new" }, target: "#m-renderer", col: 3, row: 3,
              compartments: [{ label: "renderer.js (920)", rows: [R`row tree · editable cells`, R`badges · popovers · add-person`] }] },
            { id: "n-layout", model: "@web/search/layout", change: "ctx", nlabel: "Odoo core", col: 1, row: 4,
              compartments: [{ label: "free chrome", rows: [R`breadcrumb · control panel · SearchBar`] }] },
            { id: "n-alloc", model: "planning.allocation", change: "ctx", nlabel: "res_model", target: "#views", col: 3, row: 4,
              compartments: [{ label: "unchanged model", rows: [R`every filter dimension already on it`] }] },
          ],
          edges: [
            { from: "n-action", to: "n-view", kind: "new", label: "view_mode" },
            { from: "n-backend", to: "n-view", kind: "derived", label: "registers type" },
            { from: "n-view", to: "n-controller", kind: "new", label: "Controller" },
            { from: "n-view", to: "n-model", kind: "new", label: "Model" },
            { from: "n-view", to: "n-renderer", kind: "new", label: "Renderer" },
            { from: "n-controller", to: "n-layout", kind: "new", label: "wraps · breadcrumb + SearchBar", thick: true },
            { from: "n-model", to: "n-alloc", kind: "ctx", label: "domain + searchRead / RPC" },
          ],
        },
      ],
    },

    /* ---- view descriptor ---- */
    {
      id: "m-view",
      nav: { label: "preplanning_macro_view.js", group: "Components (JS)", file: true, status: "M" },
      heading: { icon: "file-diff", change: "mod", title: "View descriptor", badge: { cls: "mod", label: "−1352 / +51", octicon: "diff-modified" } },
      files: [{ status: "M", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_view.js" }],
      blocks: [
        { c: "intro", html: R`The old 1,300-line monolith collapses into a plain descriptor object registered in the
          <code>views</code> registry — the same shape Odoo's list/form/kanban views use.` },
        { c: "h3", text: "Descriptor keys" },
        {
          c: "fields",
          headers: ["Descriptor key", "Value", "Role"],
          rows: [
            { name: "type", type: '"preplanning_macro"', note: R`The view type. Matches the <code>ir.ui.view</code> selection registered server-side.` },
            { name: "ArchParser / Model / Controller / Renderer", type: "class", note: R`The four MVC parts, wired together by <code>props()</code>.` },
            { name: "searchMenuTypes", type: "string[]", note: R`<code>["filter", "favorite"]</code> — <b>no <code>groupBy</code></b>. This is what locks the hierarchy.` },
            { name: "multiRecord", type: "boolean", note: R`<code>true</code> — operates over a recordset, not a single record.` },
          ],
        },
        { c: "h3", text: "props()" },
        { c: "methods", items: [{ sig: "props(genericProps, view)", html: R`Runs the ArchParser over the arch and hands the Model/Renderer + parsed <code>archInfo</code> down to the Controller. The only glue the descriptor needs.` }] },
        {
          c: "code",
          path: "preplanning_macro_view.js",
          lang: "javascript",
          code: R`export const preplanningMacroView = {
    type: "preplanning_macro",
    display_name: _t("Pre-planning"),
    icon: "fa fa-calendar-check-o",
    multiRecord: true,
    // No "groupBy": the row hierarchy (Opportunity > Service/Role > Person)
    // is fixed by the renderer, so it cannot be reshaped from the UI.
    searchMenuTypes: ["filter", "favorite"],
    ArchParser: PreplanningMacroArchParser,
    Controller: PreplanningMacroController,
    Model: PreplanningMacroModel,
    Renderer: PreplanningMacroRenderer,

    props(genericProps, view) {
        const archInfo = new view.ArchParser().parse(genericProps.arch);
        return {...genericProps, Model: view.Model, Renderer: view.Renderer, archInfo};
    },
};

registry.category("views").add("preplanning_macro", preplanningMacroView);`,
        },
      ],
    },

    /* ---- controller ---- */
    {
      id: "m-controller",
      nav: { label: "preplanning_macro_controller.js", group: "Components (JS)", file: true, status: "A" },
      heading: { icon: "file-added", change: "new", title: "Controller", badge: { cls: "new", label: "new", octicon: "diff-added" } },
      files: [
        { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_controller.js" },
        { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_controller.xml" },
      ],
      blocks: [
        { c: "intro", html: R`The chassis. It instantiates the Model, mounts the Renderer inside Odoo's <code>Layout</code> (breadcrumb +
          control panel + <code>SearchBar</code> for free), and owns the view toolbar for the non-filter axes.` },
        { c: "h3", text: "Setup & state" },
        {
          c: "fields",
          headers: ["Name", "Kind", "Note"],
          rows: [
            { name: "static components", type: "{Layout, SearchBar, CogMenu}", note: R`The standard chrome it composes.` },
            { name: "this.model", type: "PreplanningMacroModel", note: R`<code>useModelWithSampleData(this.props.Model, …)</code>.` },
            { name: "this.searchBarToggler", type: "hook", note: R`<code>useSearchBarToggler()</code> — wires the SearchBar into the layout.` },
          ],
        },
        { c: "h3", text: "Toolbar handlers (delegate to the Model)" },
        {
          c: "methods",
          items: [
            { sig: "previousYear() / nextYear() / onYearChange(ev)", html: R`<code>this.model.setYear(...)</code> → the Model re-fetches the year window.` },
            { sig: "onDisplayUnitClick(ev)", html: R`<code>this.model.setDisplayUnit("days" | "hours")</code> — pure display, no refetch.` },
            { sig: "onOverloadsOnlyChange(ev)", html: R`<code>this.model.setOverloadsOnly(checked)</code> — a client-side capacity predicate.` },
          ],
        },
        { c: "h3", text: "The Layout wrap (controller.xml)" },
        {
          c: "code",
          path: "preplanning_macro_controller.xml",
          lang: "markup",
          code: R`<t t-name="acme_planning.PreplanningMacroController">
    <Layout className="'o_acme_macro_preplanning_view'" display="props.display">
        <t t-set-slot="layout-actions">
            <SearchBar toggler="searchBarToggler"/>
        </t>
        <t t-set-slot="control-panel-navigation-additional">
            <!-- view toolbar: display unit · year picker · overloads-only -->
        </t>
        <t t-component="props.Renderer" t-props="rendererProps"/>
    </Layout>
</t>`,
        },
        { c: "callout", html: R`Everything in that template except the toolbar slot is Odoo's. The breadcrumb and control panel aren't
          re-implemented — they're what <code>Layout</code> renders around whatever you put inside it.` },
      ],
    },

    /* ---- model ---- */
    {
      id: "m-model",
      nav: { label: "preplanning_macro_model.js", group: "Components (JS)", file: true, status: "A" },
      heading: { icon: "file-added", change: "new", title: "Model", badge: { cls: "new", label: "new", octicon: "diff-added" } },
      files: [{ status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_model.js" }],
      blocks: [
        { c: "intro", html: R`Extends <code>@web/model/model</code>'s <code>Model</code>. Owns all the data and the view-axis state; the
          search domain flows in through <code>load()</code> and is combined with the active year window.` },
        { c: "h3", text: "State" },
        {
          c: "fields",
          headers: ["Name", "Kind", "Note"],
          rows: [
            { name: "year / displayUnit / overloadsOnly", type: "view axes", note: R`The toolbar's state. <code>setYear</code> refetches; <code>setDisplayUnit</code> only notifies; <code>setOverloadsOnly</code> re-filters in memory.` },
            { name: "_searchDomain", type: "DomainListRepr", note: R`Last domain from the SearchBar (set by <code>load</code>).` },
            { name: "baseYearData / yearData", type: "MacroYearData", note: R`Full year vs. the overload-filtered view the Renderer reads.` },
            { name: "capacityPositions / annualEnvelopes / capacityOverlayCache", type: "capacity maps", note: R`Capacity overlays, cached per year+employee set.` },
          ],
        },
        { c: "h3", text: "Methods" },
        {
          c: "methods",
          items: [
            { sig: "async load(searchParams = {})", html: R`Entry point. Stashes <code>searchParams.domain</code>, ensures meta (available years, hours/day), then reloads.` },
            { sig: "async _fetchAllocations()", html: R`<code>searchRead</code> with <code>[...yearDomain(), ..._searchDomain]</code> — the year window and the SearchBar domain composed.` },
            { sig: "async _loadCapacityOverlays(token)", html: R`Fetches capacity per employee, cached; a token guards against out-of-order reloads.` },
            { sig: "_applyOverloadFilter()", html: R`Rebuilds <code>yearData</code> from <code>baseYearData</code>, keeping only overloaded employees when the toggle is on.` },
          ],
        },
        {
          c: "code",
          path: "preplanning_macro_model.js",
          lang: "javascript",
          code: R`async load(searchParams = {}) {
    this._searchDomain = Array.isArray(searchParams.domain) ? searchParams.domain : [];
    await this._ensureMeta();
    await this._reload();
}

async _fetchAllocations() {
    const domain = [...this.yearDomain(), ...this._searchDomain];   // year window + SearchBar
    const records = await this.orm.searchRead(RES_MODEL, domain, ALLOCATION_FIELDS, {order: "month, id"});
    return records.map((r) => normalizeAllocation(r, this.hoursPerDay)).filter(Boolean).sort(compareAllocations);
}`,
        },
      ],
    },

    /* ---- renderer ---- */
    {
      id: "m-renderer",
      nav: { label: "preplanning_macro_renderer.js", group: "Components (JS)", file: true, status: "A" },
      heading: { icon: "file-added", change: "new", title: "Renderer", badge: { cls: "new", label: "new · 920 lines", octicon: "diff-added" } },
      files: [
        { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_renderer.js" },
        { status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_renderer.xml" },
      ],
      blocks: [
        { c: "intro", html: R`The grid, moved across from the old monolith essentially unchanged (ADR-0005 behaviour preserved). An OWL
          <code>Component</code> that draws the fixed Opportunity → Role → Person row tree over a 12-month axis.` },
        { c: "h3", text: "What it owns" },
        {
          c: "methods",
          items: [
            { sig: "toggleRow(row) / isClosed(row)", html: R`Expand/collapse the row tree (hierarchy is fixed — only open/close, never regroup).` },
            { sig: "editableCell / monthCell / editPayload", html: R`The in-cell month editing; <code>editPayload</code> builds the write the Model sends.` },
            { sig: "capacityBadge / toggleCapacityPopover", html: R`Per-cell capacity badge state and its popover.` },
            { sig: "onAddPersonSelectionChange / canAddPerson", html: R`The “add a person under this role” flow, including the “To assign” pending rows.` },
            { sig: "openOpportunity(row) / openForm(resModel, resId)", html: R`Drill into the source opportunity or an allocation form.` },
          ],
        },
        { c: "callout", tone: "warn", html: R`This is the big file (920 lines) but the <b>least interesting in the diff</b>: it's a move, not new logic. Review it
          for what changed against the old version, not as fresh code.` },
      ],
    },

    /* ---- arch parser ---- */
    {
      id: "m-archparser",
      nav: { label: "preplanning_macro_arch_parser.js", group: "Components (JS)", file: true, status: "A" },
      heading: { icon: "file-added", change: "new", title: "ArchParser", badge: { cls: "new", label: "new", octicon: "diff-added" } },
      files: [{ status: "A", path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_arch_parser.js" }],
      blocks: [
        { c: "intro", html: R`Intentionally thin. The arch isn't configurable layout — the hierarchy and month axis are fixed by the
          Renderer — so the parser just collects the <code>&lt;field&gt;</code> names the Model should load, keeping the field
          list visible and reviewable on the view record like any other Odoo view.` },
        { c: "methods", items: [{ sig: "parse(arch) → { fieldNames }", html: R`Walks <code>&lt;field name="…"/&gt;</code> children; falls back to <code>ALLOCATION_FIELDS</code> if empty.` }] },
        {
          c: "code",
          path: "preplanning_macro_arch_parser.js",
          lang: "javascript",
          code: R`export class PreplanningMacroArchParser {
    parse(arch) {
        const fieldNames = [];
        for (const child of arch.children) {
            if (child.tagName !== "field") continue;
            const name = child.getAttribute("name");
            if (name && !fieldNames.includes(name)) fieldNames.push(name);
        }
        return {fieldNames: fieldNames.length ? fieldNames : [...ALLOCATION_FIELDS]};
    }
}`,
        },
      ],
    },

    /* ---- backend registration ---- */
    {
      id: "m-backend",
      nav: { label: "ir_ui_view.py", group: "Backend (Python)", file: true, status: "A" },
      heading: { icon: "file-added", change: "new", title: "ir.ui.view — server-side type registration", badge: { cls: "new", label: "new", octicon: "diff-added" } },
      files: [{ status: "A", path: "addons/acme_planning/models/ir_ui_view.py" }],
      blocks: [
        { c: "intro", html: R`A view type only exists to the client if the server knows it too. This teaches Odoo the
          <code>preplanning_macro</code> type — mirroring how <code>web_planning_view</code> registers <code>planning</code>.` },
        { c: "h3", text: "What it adds" },
        {
          c: "fields",
          headers: ["Adds", "Kind", "Effect"],
          rows: [
            { name: "ir.ui.view.type", type: "selection_add", note: R`Adds <code>("preplanning_macro", "Pre-planning Macro")</code> so view records can declare the type.` },
            { name: "_is_qweb_based_view", type: "override", note: R`Skips strict list/form field validation — the view ships its own OWL renderer, not a structured arch.` },
            { name: "_get_view_info", type: "override", note: R`Registers the type's icon (<code>fa fa-calendar-check-o</code>).` },
            { name: "act_window.view.view_mode", type: "selection_add", note: R`Lets an <code>ir.actions.act_window</code> open in <code>preplanning_macro</code> mode (with <code>ondelete cascade</code>).` },
          ],
        },
        {
          c: "code",
          path: "addons/acme_planning/models/ir_ui_view.py",
          lang: "python",
          code: R`class IrUiView(models.Model):
    _inherit = "ir.ui.view"

    type = fields.Selection(selection_add=[("preplanning_macro", "Pre-planning Macro")])

    def _is_qweb_based_view(self, view_type):
        # Ships its own OWL renderer; not a structured (list/form) arch, so skip
        # the strict field validation — like the planning view.
        return super()._is_qweb_based_view(view_type) or view_type == "preplanning_macro"

    def _get_view_info(self):
        return {"preplanning_macro": {"icon": "fa fa-calendar-check-o"}} | super()._get_view_info()


class ActWindowView(models.Model):
    _inherit = "ir.actions.act_window.view"

    view_mode = fields.Selection(
        selection_add=[("preplanning_macro", "Pre-planning Macro")],
        ondelete={"preplanning_macro": "cascade"},
    )`,
        },
      ],
    },

    /* ---- views & search ---- */
    {
      id: "views",
      nav: { label: "Views & search", icon: "table", group: "Surface" },
      heading: { icon: "table", title: "Views, search arch &amp; action" },
      files: [
        { status: "M", path: "addons/acme_planning/views/planning_allocation_views.xml" },
        { status: "M", path: "addons/acme_planning/views/acme_planning_views.xml" },
      ],
      blocks: [
        { c: "intro", html: R`Three XML records carry the rebuild: the macro view (just a field list), a dedicated
          <code>&lt;search&gt;</code> arch (the filters, no group-by), and the action — now an <code>act_window</code> instead of a
          client action.` },
        { c: "h3", text: "The macro view + search arch" },
        {
          c: "code",
          path: "views/planning_allocation_views.xml",
          lang: "markup",
          code: R`<record id="view_planning_allocation_preplanning_macro" model="ir.ui.view">
    <field name="model">planning.allocation</field>
    <field name="type">preplanning_macro</field>
    <field name="arch" type="xml">
        <preplanning_macro>
            <field name="opportunity_id"/> <field name="opportunity_team_id"/>
            <field name="product_id"/> <field name="role_id"/> <field name="employee_id"/>
            <field name="month"/> <field name="quantity"/> <field name="status"/>
        </preplanning_macro>
    </field>
</record>

<record id="view_planning_allocation_preplanning_search" model="ir.ui.view">
    <field name="model">planning.allocation</field>
    <field name="arch" type="xml">
        <search string="Pre-planning">
            <field name="opportunity_id"/> <field name="role_id"/>
            <field name="employee_id" string="Person"/>
            <field name="opportunity_team_id" string="Sales Team"/>
            <filter name="forecast"  string="Forecast"  domain="[('status','=','forecast')]"/>
            <filter name="converted" string="Converted" domain="[('status','=','converted')]"/>
            <separator/>
            <filter name="to_assign" string="To assign" domain="[('employee_id','=',False)]"/>
            <!-- no group-by filters: the hierarchy is fixed -->
        </search>
    </field>
</record>`,
        },
        { c: "h3", text: "The action: client → act_window" },
        {
          c: "code",
          path: "views/acme_planning_views.xml",
          lang: "markup",
          code: R`-<record id="action_acme_preplanning_macro" model="ir.actions.client">
-    <field name="tag">acme_planning.preplanning_macro_view</field>
+<record id="action_acme_preplanning_macro" model="ir.actions.act_window">
+    <field name="res_model">planning.allocation</field>
+    <field name="view_mode">preplanning_macro</field>
+    <field name="view_id" ref="view_planning_allocation_preplanning_macro"/>
+    <field name="search_view_id" ref="view_planning_allocation_preplanning_search"/>`,
        },
        { c: "h3", text: "Removed by this rebuild" },
        {
          c: "removed",
          title: "Deleted — native search replaces both",
          items: [
            { path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_filters.js", del: 261, why: "the hand-rolled filter bar" },
            { path: "addons/acme_planning/static/src/preplanning_macro/preplanning_macro_view.xml", del: 366, why: "the old client-action template" },
          ],
        },
      ],
    },

    /* ---- wizards ---- */
    {
      id: "wizards",
      nav: { label: "Wizards", icon: "gear", group: "Surface" },
      heading: { icon: "gear", title: "Wizards" },
      blocks: [
        { c: "cards", cols: 1, items: [{ html: R`<p style="margin-top:0"><b>None.</b> No transient models in this PR — it's a chassis swap around an existing screen.</p>` }] },
      ],
    },

    /* ---- security ---- */
    {
      id: "security",
      nav: { label: "Security", icon: "shield-lock", group: "Surface" },
      heading: { icon: "shield-lock", title: "Security" },
      blocks: [
        { c: "cards", cols: 1, items: [{ html: R`<p style="margin-top:0"><b>No ACL or record-rule changes.</b> The screen still reads and writes
          <code>planning.allocation</code> — the same model, through the same existing access rights. Only the <i>chassis</i>
          around it changed, so the security surface is untouched.</p>` }] },
      ],
    },

    /* ---- patterns ---- */
    {
      id: "concepts",
      nav: { label: "Patterns", icon: "light-bulb", group: "Deep dive" },
      heading: { icon: "light-bulb", title: "Patterns worth stealing" },
      blocks: [
        { c: "intro", html: R`How to turn a bespoke client action into a first-class Odoo view — reusable for any custom screen.` },
        {
          c: "patterns",
          items: [
            { icon: "git-branch", term: "Custom view type (MVC)", html: R`Register <code>{type, ArchParser, Model, Controller, Renderer, props}</code> in the <code>views</code> registry instead of a client action.`, ref: "registry.category(\"views\")" },
            { icon: "columns", term: "Free chrome via Layout", html: R`Wrap the Renderer in <code>@web/search/layout</code> <code>Layout</code> + <code>SearchBar</code> and inherit the breadcrumb, control panel, and search facets.`, ref: "@web/search/layout" },
            { icon: "shield-lock", term: "Lock the grouping", html: R`Omit <code>groupBy</code> from <code>searchMenuTypes</code> and define no group-by in the search arch, so a fixed hierarchy can't be reshaped.`, ref: "searchMenuTypes" },
            { icon: "database", term: "Server-side type registration", html: R`<code>type</code> + <code>view_mode</code> <code>selection_add</code>, plus <code>_is_qweb_based_view</code> to skip structured-arch validation.`, ref: "ir_ui_view.py" },
            { icon: "eye", term: "Toolbar for non-domain axes", html: R`Filters that aren't stored fields (a capacity-derived “overloads” lens) live in a view toolbar, not the SearchBar.`, ref: "controller.xml" },
            { icon: "rows", term: "Thin arch, fixed layout", html: R`When layout is fixed, let the arch carry only the field list — visible and reviewable on the view record, parsed by a tiny ArchParser.`, ref: "arch_parser.js" },
          ],
        },
      ],
    },

    /* ---- files ---- */
    {
      id: "files",
      nav: { label: "Files changed", icon: "file-diff", group: "Deep dive" },
      heading: { icon: "file-diff", title: R`Files changed <span class="tag" style="font-size:13px">22 files</span>` },
      blocks: [
        { c: "files" },
        { c: "h3", text: "Verification" },
        { c: "p", html: R`<code>preplanning_macro_view.test.js</code> rewritten to the new chassis: Hoot <b>21/21</b> (206 assertions) —
          control panel + search bar present, group-by locked, native filters (Forecast / To assign), overloads composing
          with a filter, plus the preserved grid/edit/badge/popover/year-nav cases. Python: <code>acme_planning</code> 143
          tests + tours, 0 failed.` },
      ],
    },
  ],

  footerHtml: R`Generated walkthrough of <b>Rebuild opportunity pre-planning as a native Odoo view</b> (#93,
    <span class="gh-state merged" style="padding:1px 7px;font-size:11px">merged</span>) ·
    <span class="mono">feature/preplanning-native-odoo-view</span> → <span class="mono">dev</span>.`,
};

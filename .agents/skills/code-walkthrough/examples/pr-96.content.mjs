/* Worked example for the code-walkthrough skill: PR #96 of Acme.
   Build it with:  node ../scripts/build.mjs pr-96.content.mjs pr-96.html
   Code blocks use String.raw template literals (no JSON escaping). */

const R = String.raw;

export default {
  pr: {
    number: 96,
    title: "Add live planning pool items",
    state: "open",
    url: "https://github.com/acme-co/planning-suite/pull/96",
    author: "octocat",
    baseRef: "dev",
    headRef: "feature/59-shared-pool-remaining-to-schedule",
    commits: 1,
    module: "acme_planning",
    summaryHtml: R`Adds <code>planning.pool.item</code>, a read-only SQL-view lens over active <b>Converted</b>
      allocations. Each pool item keeps allocation grain and exposes <b>total</b>, <b>already planned</b>,
      and <b>remaining</b> charge from the source allocation plus its non-cancelled linked
      <code>planning.slot</code> rows. Closes&nbsp;#59.`,
    stats: {
      filesChanged: 21,
      additions: 1040,
      deletions: 0,
      extra: ["1 new model", "3 models touched", "0 wizards"],
    },
    highlights: [
      { icon: "🗄️", title: "One new model", html: R`<code>planning.pool.item</code> — an <code>_auto=False</code> SQL view. No new table, no second copy of the charge.` },
      { icon: "🔗", title: "One new link", html: R`<code>planning.slot.allocation_id</code> lets a shift <i>consume</i> a source allocation. That link is the whole engine.` },
      { icon: "📊", title: "Derived readings", html: R`total / placed / remaining are <b>computed</b> on the fly from linked slots — never stored, never decremented.` },
    ],
  },

  files: [
    { status: "A", path: "addons/acme_planning/models/planning_pool_item.py", href: "#m-pool", add: 166, del: 0 },
    { status: "A", path: "addons/acme_planning/views/planning_pool_item_views.xml", href: "#views", add: 122, del: 0 },
    { status: "A", path: "addons/acme_planning/tests/test_planning_pool_item.py", href: "#tests", add: 281, del: 0 },
    { status: "A", path: "docs/adr/0008-pool-item-derived-lens-consumed-by-slots.md", add: 47, del: 0 },
    { status: "M", path: "addons/acme_planning/models/planning_allocation.py", href: "#m-alloc", add: 78, del: 0 },
    { status: "M", path: "addons/acme_planning/models/planning_slot.py", href: "#m-slot", add: 21, del: 0 },
    { status: "M", path: "addons/acme_planning/models/project_project.py", href: "#m-project", add: 26, del: 0 },
    { status: "M", path: "addons/acme_planning/models/__init__.py", add: 1, del: 0 },
    { status: "M", path: "addons/acme_planning/security/ir.model.access.csv", href: "#security", add: 3, del: 0 },
    { status: "M", path: "addons/acme_planning/security/planning_rules.xml", href: "#security", add: 33, del: 0 },
    { status: "M", path: "addons/acme_planning/views/planning_allocation_views.xml", href: "#views", add: 17, del: 0 },
    { status: "M", path: "addons/acme_planning/views/planning_slot_views.xml", href: "#views", add: 3, del: 0 },
    { status: "M", path: "addons/acme_planning/views/project_project_views.xml", href: "#views", add: 12, del: 0 },
    { status: "M", path: "addons/acme_planning/views/crm_lead_views.xml", href: "#views", add: 4, del: 0 },
    { status: "M", path: "addons/acme_planning/views/acme_planning_views.xml", href: "#views", add: 1, del: 0 },
    { status: "M", path: "addons/acme_planning/__manifest__.py", add: 1, del: 0 },
    { status: "M", path: "addons/acme_planning/tests/__init__.py", add: 1, del: 0 },
    { status: "M", path: "addons/acme_planning/readme/USAGE.md", add: 14, del: 0 },
    { status: "M", path: "addons/acme_planning/i18n/fr.po", href: "#i18n", add: 101, del: 0 },
    { status: "M", path: "addons/acme_planning/i18n/acme_planning.pot", href: "#i18n", add: 100, del: 0 },
    { status: "M", path: "CONTEXT.md", add: 8, del: 0 },
  ],

  sections: [
    /* ---- overview (PR header + hero rendered from pr; nav only) ---- */
    { id: "overview", nav: { label: "Overview", icon: "list-unordered", group: "Orientation" }, blocks: [] },

    /* ---- why this PR exists ---- */
    {
      id: "mental-model",
      nav: { label: "Why this PR exists", icon: "git-compare", group: "Orientation" },
      heading: { icon: "git-compare", title: "Why this PR exists" },
      blocks: [
        { c: "intro", html: R`Reviewing this with a queue behind you? The diff is wider than the idea. Here's the idea.` },
        { c: "p", html: R`When a quote is confirmed, the workload behind it becomes real but unscheduled. A line might read
          <i>Dana Lopez owes Project Atlas six days of site surveys in March 2027</i>: agreed and sold, sitting on zero
          calendars. Someone, usually the manager, still has to drop those days onto actual dates, and until this PR no screen
          told them how much of that confirmed work was still waiting for one.` },
        { c: "callout", tone: "key", html: R`<b>“Shared pool”</b> is the team’s name for it: the pile of confirmed-but-unscheduled work. Open a confirmed
          project, click <b>Remaining to Schedule</b>, and you get one row per chunk of it:
          <span class="mono" style="color:var(--txt)">Dana Lopez · Project Atlas · March 2027 · 6 d total · 4 placed · 2 left</span>.
          The planner works that list down to zero. (PRD: EF-CON-3, EF-PLN-3.)` },
        { c: "h3", text: "The one thing to check the rest of the diff against" },
        { c: "p", html: R`The pool stores none of those numbers. “2 left” isn't a column that gets decremented when a shift appears; it's
          <code>max(total − placed, 0)</code>, recomputed the instant you read it, where <code>placed</code> is just the summed
          hours of every shift pointing back at that same confirmed allocation. So <code>planning.pool.item</code> is a SQL
          view, a saved query over the allocations, not a table of its own. Create a shift and the remaining drops. Resize it,
          cancel it, delete it, hand it to a different allocation, and the figure tracks it every time.` },
        {
          c: "flow",
          steps: [
            "CRM opportunity",
            R`allocation <span class="tag">forecast</span>`,
            R`quote confirmed <span class="tag">converted</span>`,
            "🟢 pool row shows up",
            "planner places shifts",
            "2 left → 0",
          ],
        },
        { c: "h3", text: "What it deliberately doesn't do" },
        { c: "p", html: R`Nothing here generates shifts for you. That’s a deliberate rule, not a missing feature: never bulk-create dated shifts
          without a human deciding (EF-CON-3). For now a planner sets <b>Source Allocation</b> on a shift by hand, and that one
          link is the whole engine. The generation wizard is later, in #62; when it ships it must push slots through this exact
          link instead of inventing a second way to drain the pool.` },
      ],
    },

    /* ---- model map (diagram) ---- */
    {
      id: "map",
      nav: { label: "Model map", icon: "git-branch", group: "Orientation" },
      heading: { icon: "git-branch", title: "Model map" },
      blocks: [
        {
          c: "diagram",
          intro: R`An object-diagram view (UML-ish, not strict). <b>Click a box</b> to jump to its detail card.
            <b>Hover a box</b> to light up only its relationships.`,
          hint: R`↳ The thick green arrow <b>slot → allocation</b> is the engine of this PR. Everything else reads off it.`,
          nodes: [
            { id: "n-crm", model: "crm.lead", change: "ctx", nlabel: "Opportunity", target: "#m-alloc", col: 1, row: 1,
              compartments: [{ label: "context", rows: [R`<span class="k">type</span> = opportunity`] }] },
            { id: "n-project", model: "project.project", change: "mod", badge: { cls: "mod", label: "mod" }, target: "#m-project", col: 3, row: 1,
              compartments: [
                { label: "+ field", rows: [R`<span class="k">planning_pool_item_count</span>`] },
                { label: "+ method", rows: [R`<span class="k">action_open_planning_pool_items()</span>`] },
              ] },
            { id: "n-alloc", model: "planning.allocation", change: "mod", badge: { cls: "mod", label: "hub" }, target: "#m-alloc", col: 2, row: 2,
              compartments: [
                { label: "+ derived fields", rows: [R`<span class="k">planned_* · remaining_*</span>`, R`<span class="k">planning_slot_ids</span> O2m`] },
                { label: "+ method", rows: [R`<span class="k">_planning_placed_hours_by_id()</span>`] },
              ] },
            { id: "n-pool", model: "planning.pool.item", change: "new", badge: { cls: "new", label: "new" }, target: "#m-pool", col: 3, row: 2,
              compartments: [
                { label: "SQL view · _auto = False", rows: [R`<span class="k">allocation_id</span> · total`, R`<span class="k">placed</span> · remaining`] },
                { label: "init() → CREATE VIEW", rows: [] },
              ] },
            { id: "n-slot", model: "planning.slot", change: "mod", badge: { cls: "mod", label: "mod" }, target: "#m-slot", col: 2, row: 3,
              compartments: [
                { label: "+ field (the link)", rows: [R`<span class="k">allocation_id</span> M2o → allocation`] },
                { label: "+ constraint", rows: [R`<span class="k">_check_source_allocation_is_confirmed</span>`] },
              ] },
          ],
          edges: [
            { from: "n-crm", to: "n-alloc", kind: "ctx", label: "opportunity_id · M2o" },
            { from: "n-alloc", to: "n-pool", kind: "derived", label: "SQL view · converted+active" },
            { from: "n-slot", to: "n-alloc", kind: "new", label: "allocation_id ↔ planning_slot_ids", thick: true },
            { from: "n-project", to: "n-pool", kind: "new", label: "smart button · _read_group" },
          ],
        },
      ],
    },

    /* ---- planning.pool.item ---- */
    {
      id: "m-pool",
      nav: { label: "planning_pool_item.py", group: "Models", file: true, status: "A" },
      heading: { icon: "file-added", change: "new", title: "planning.pool.item", badge: { cls: "new", label: "new model", octicon: "diff-added" } },
      files: [{ status: "A", path: "addons/acme_planning/models/planning_pool_item.py" }],
      blocks: [
        { c: "intro", html: R`A read-only <b>SQL view</b> model (<code>_auto = False</code>). Grain: <b>one row per source allocation</b>,
          so prestation, task and allocation identity survive into planning.` },
        { c: "attrs", items: ['_name = "planning.pool.item"', "_auto = False", '_rec_name = "name"'] },
        { c: "h3", text: "Fields" },
        {
          c: "fields",
          rows: [
            { name: "name", type: "Char · compute", note: R`Human label: <i>project – service – role – month – person</i>.`, badges: [{ cls: "ro", label: "computed" }] },
            { name: "allocation_id", type: "Many2one", note: R`→ <code>planning.allocation</code>. The source row this lens reflects.`, badges: [{ cls: "ro", label: "readonly" }] },
            { name: "opportunity_id / demand_id", type: "Many2one", note: R`→ <code>crm.lead</code> / <code>planning.allocation.demand</code>, carried from the allocation.` },
            { name: "product_id / role_id / employee_id", type: "Many2one", note: R`→ service / <code>planning.role</code> / <code>hr.employee</code> (empty = <i>To assign</i>).` },
            { name: "person_or_role_name", type: "Char · compute", note: R`Named person, or “To assign”. Reads <code>allocation.assignee_name</code>.` },
            { name: "project_id / task_id", type: "Many2one", note: R`→ <code>project.project</code> / <code>project.task</code>, gained at conversion.` },
            { name: "analytic_account_id", type: "Many2one", note: R`→ <code>account.analytic.account</code>.` },
            { name: "month", type: "Date", note: R`Allocation month — the planning bucket.` },
            { name: "quantity_unit", type: "Selection", note: R`<code>days</code> / <code>hours</code> — the unit the totals are expressed in.` },
            { name: "total / total_hours", type: "Float · compute", note: R`<b>Charge to schedule</b> = allocation quantity (and in hours).` },
            { name: "placed / placed_hours", type: "Float · compute", note: R`<b>Already planned</b> = Σ <code>allocated_hours</code> of non-cancelled linked slots.` },
            { name: "remaining / remaining_hours", type: "Float · compute", note: R`<b>Reste à planifier</b> = <code>max(total − placed, 0)</code>.` },
            { name: "company_id", type: "Many2one", note: R`→ <code>res.company</code>; drives the record rules.` },
          ],
        },
        { c: "h3", text: "Methods" },
        {
          c: "methods",
          items: [
            { decorator: "def init(self):", sig: "init()", html: R`Drops any existing view, then <code>CREATE OR REPLACE VIEW</code> selecting allocations <code>WHERE status = 'converted' AND active IS TRUE</code>. The allocation <code>id</code> becomes the pool item <code>id</code>.` },
            { decorator: "@api.depends(allocation_id.quantity, .planning_slot_ids.allocated_hours, .state)", sig: "_compute_quantities()", html: R`Calls the allocation's shared aggregator <code>_planning_placed_hours_by_id()</code>, then fills total / placed / remaining in both unit and hours, flooring remaining at zero.` },
          ],
        },
        {
          c: "code",
          path: "addons/acme_planning/models/planning_pool_item.py",
          lang: "python",
          code: R`class PlanningPoolItem(models.Model):
    _name = "planning.pool.item"
    _auto = False                       # ← SQL view, no managed table
    _order = "project_id, month, product_id, role_id, employee_id, id"
    _rec_name = "name"

    allocation_id = fields.Many2one("planning.allocation", string="Source Allocation", readonly=True)
    total = fields.Float(compute="_compute_quantities", string="Total")
    placed = fields.Float(compute="_compute_quantities", string="Already Planned")
    remaining = fields.Float(compute="_compute_quantities", string="Remaining to Schedule")

    def init(self):
        drop_view_if_exists(self.env.cr, self._table)
        self.env.cr.execute(SQL(
            """
            CREATE OR REPLACE VIEW %s AS (
                SELECT allocation.id AS id, allocation.id AS allocation_id, ...
                FROM planning_allocation allocation
                WHERE allocation.status = 'converted' AND allocation.active IS TRUE
            )
            """,
            SQL.identifier(self._table),
        ))

    @api.depends("allocation_id.quantity", "allocation_id.quantity_hours",
                 "allocation_id.planning_slot_ids.allocated_hours",
                 "allocation_id.planning_slot_ids.state")
    def _compute_quantities(self):
        placed = self.mapped("allocation_id")._planning_placed_hours_by_id()
        for item in self:
            a = item.allocation_id
            placed_hours = placed.get(a.id, 0.0)
            item.total = a.quantity
            item.placed = a._hours_to_quantity(placed_hours, a.quantity_unit)
            item.remaining = a._hours_to_quantity(max(a.quantity_hours - placed_hours, 0.0), a.quantity_unit)`,
        },
        { c: "callout", html: R`<b>Why a SQL view and not a stored model?</b> A copied pool table would create a second charge store
          that issue #60 and #62 would have to reconcile. A view can't drift: it <i>is</i> the allocations.` },
      ],
    },

    /* ---- planning.allocation ---- */
    {
      id: "m-alloc",
      nav: { label: "planning_allocation.py", group: "Models", file: true, status: "M" },
      heading: { icon: "file-diff", change: "mod", title: "planning.allocation", badge: { cls: "mod", label: "modified", octicon: "diff-modified" } },
      files: [{ status: "M", path: "addons/acme_planning/models/planning_allocation.py" }],
      blocks: [
        { c: "intro", html: R`The hub. It gains the same total/placed/remaining readings as the pool item, the inverse link to its slots,
          and the shared aggregator both models use.` },
        { c: "h3", text: "New fields" },
        {
          c: "fields",
          rows: [
            { name: "planned_charge_quantity / _hours", type: "Float · compute", note: R`Total confirmed charge, for the “Planning Consumption” panel.` },
            { name: "planned_quantity / planned_hours", type: "Float · compute", note: R`Already planned = Σ non-cancelled linked slot hours.` },
            { name: "remaining_quantity / remaining_hours", type: "Float · compute", note: R`<code>max(total − placed, 0)</code>.` },
            { name: "planning_slot_ids", type: "One2many", note: R`→ <code>planning.slot</code> inverse of <code>allocation_id</code>. The depends-trigger for live recompute.`, badges: [{ cls: "ro", label: "readonly" }] },
          ],
        },
        { c: "h3", text: "New methods" },
        {
          c: "methods",
          items: [
            { decorator: "@api.depends(... planning_slot_ids.allocated_hours, .state)", sig: "_compute_planning_consumption()", html: R`Fills the six new readings per allocation, converting hours back to the native unit via <code>_hours_to_quantity()</code>.` },
            { sig: "_planning_placed_hours_by_id()", html: R`<b>Shared aggregator</b>, reused by the pool item. One <code>_read_group</code> over <code>planning.slot</code> (<code>.sudo()</code>) summing <code>allocated_hours</code> where state ≠ cancelled, keyed by allocation id.` },
          ],
        },
        {
          c: "code",
          path: "addons/acme_planning/models/planning_allocation.py · added",
          lang: "python",
          code: R`def _planning_placed_hours_by_id(self):
    """Shared aggregator — reused by planning.pool.item._compute_quantities."""
    allocation_ids = [a.id for a in self if isinstance(a.id, int)]
    if not allocation_ids:
        return {}
    grouped_hours = self.env["planning.slot"].sudo()._read_group(
        [("allocation_id", "in", allocation_ids), ("state", "!=", "cancelled")],
        ["allocation_id"],
        ["allocated_hours:sum"],
    )
    return {a.id: hours or 0.0 for a, hours in grouped_hours}`,
        },
        { c: "callout", tone: "warn", html: R`<b>Note the <code>.sudo()</code> in the aggregator.</b> It sums all linked slots regardless of the reader's slot
          visibility, so “remaining” is consistent for every role.` },
      ],
    },

    /* ---- planning.slot ---- */
    {
      id: "m-slot",
      nav: { label: "planning_slot.py", group: "Models", file: true, status: "M" },
      heading: { icon: "file-diff", change: "mod", title: "planning.slot", badge: { cls: "mod", label: "modified", octicon: "diff-modified" } },
      files: [{ status: "M", path: "addons/acme_planning/models/planning_slot.py" }],
      blocks: [
        { c: "intro", html: R`The consumer. A single new Many2one lets a shift draw from a pool item, plus a guard that keeps the link
          pointed only at real confirmed charge.` },
        { c: "h3", text: "New field — the link" },
        {
          c: "fields",
          noteHead: "Attributes & intent",
          rows: [
            { name: "allocation_id", type: "Many2one", note: R`→ <code>planning.allocation</code>, “Source Allocation”.
              <div class="attrs" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
                <span class="tag">domain: status=converted, active=True</span>
                <span class="tag">index=True</span><span class="tag">tracking=True</span>
                <span class="tag">check_company=True</span><span class="tag">ondelete="set null"</span>
              </div>` },
          ],
        },
        { c: "p", html: R`Plus a model-level switch: <code>_check_company_auto = True</code> — auto-validates company consistency across
          <code>check_company</code> relations on write.` },
        { c: "h3", text: "New constraint" },
        {
          c: "methods",
          items: [
            { decorator: '@api.constrains("allocation_id")', sig: "_check_source_allocation_is_confirmed()", html: R`Belt-and-braces beyond the field <code>domain</code>: raises <code>ValidationError</code> if a linked allocation is not <code>converted</code> &amp; <code>active</code>. The domain filters the dropdown; the constraint defends against non-UI writes.` },
          ],
        },
        {
          c: "code",
          path: "addons/acme_planning/models/planning_slot.py · added",
          lang: "python",
          code: R`allocation_id = fields.Many2one(
    "planning.allocation",
    string="Source Allocation",
    domain=[("status", "=", "converted"), ("active", "=", True)],
    index=True, tracking=True, check_company=True,
    ondelete="set null",            # ← detach, never cascade-delete shifts
)

@api.constrains("allocation_id")
def _check_source_allocation_is_confirmed(self):
    for slot in self.filtered("allocation_id"):
        if slot.allocation_id.status != "converted" or not slot.allocation_id.active:
            raise ValidationError(_("Source allocations must be active converted allocations."))`,
        },
        { c: "callout", html: R`<b><code>ondelete="set null"</code> on purpose.</b> Deleting a confirmed allocation should not cascade-delete
          operational shifts. The shift survives, just unlinked — and the pool's “placed” drops on the next read.` },
      ],
    },

    /* ---- project.project ---- */
    {
      id: "m-project",
      nav: { label: "project_project.py", group: "Models", file: true, status: "M" },
      heading: { icon: "file-diff", change: "mod", title: "project.project", badge: { cls: "mod", label: "modified", octicon: "diff-modified" } },
      files: [{ status: "M", path: "addons/acme_planning/models/project_project.py" }],
      blocks: [
        { c: "intro", html: R`The entry point. A smart button on the confirmed project opens its slice of the pool, grouped by month.` },
        { c: "h3", text: "New field" },
        {
          c: "fields",
          rows: [
            { name: "planning_pool_item_count", type: "Integer · compute", note: R`Count of this project's pool items, for the smart-button badge.
              <div class="attrs" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px"><span class="tag">groups="acme_planning.group_planning_employee"</span></div>` },
          ],
        },
        { c: "h3", text: "New methods" },
        {
          c: "methods",
          items: [
            { sig: "_compute_planning_pool_item_count()", html: R`One <code>_read_group</code> over <code>planning.pool.item</code> by <code>project_id</code> with <code>__count</code> — no per-record query.` },
            { sig: "action_open_planning_pool_items()", html: R`Returns the <code>action_planning_pool_item</code> window action, narrowed to this project and defaulting to <i>group by month</i>.` },
          ],
        },
        {
          c: "code",
          path: "addons/acme_planning/models/project_project.py · added",
          lang: "python",
          code: R`def action_open_planning_pool_items(self):
    self.ensure_one()
    action = self.env["ir.actions.actions"]._for_xml_id("acme_planning.action_planning_pool_item")
    action["domain"] = [("project_id", "=", self.id)]
    action["context"] = {"search_default_group_by_month": 1}
    return action`,
        },
      ],
    },

    /* ---- views ---- */
    {
      id: "views",
      nav: { label: "Views & intent", icon: "table", group: "Surface" },
      heading: { icon: "table", title: "Views &amp; their intent" },
      files: [
        { status: "A", path: "addons/acme_planning/views/planning_pool_item_views.xml" },
        { status: "M", path: "addons/acme_planning/views/project_project_views.xml" },
        { status: "M", path: "addons/acme_planning/views/planning_allocation_views.xml" },
        { status: "M", path: "addons/acme_planning/views/planning_slot_views.xml" },
        { status: "M", path: "addons/acme_planning/views/crm_lead_views.xml" },
        { status: "M", path: "addons/acme_planning/views/acme_planning_views.xml" },
      ],
      blocks: [
        { c: "intro", html: R`One new view file (the pool item's list/form/search/action) plus surgical inherits that surface the new
          readings where planners already work.` },
        {
          c: "cards",
          cols: 2,
          items: [
            { title: "🆕 planning_pool_item_views.xml", html: R`The pool's own surface — deliberately <b>read-only</b>: a list with
              <code>create/edit/delete="False"</code>, a read-only form, a group-by search, and the window action.` },
            { title: "Why read-only everywhere?", html: R`A SQL-view model can't be written anyway, but stamping <code>create/edit/delete="False"</code>
              makes the intent explicit and stops Odoo from rendering dead “New” buttons.` },
          ],
        },
        {
          c: "code",
          path: "addons/acme_planning/views/planning_pool_item_views.xml",
          lang: "markup",
          code: R`<record id="action_planning_pool_item" model="ir.actions.act_window">
    <field name="name">Remaining to Schedule</field>
    <field name="res_model">planning.pool.item</field>
    <field name="view_mode">list,form</field>
    <field name="search_view_id" ref="view_planning_pool_item_search"/>
</record>`,
        },
        { c: "h3", text: "Inherited views (surfacing the readings)" },
        {
          c: "table",
          head: ["File", "Change", "Intent"],
          firstColMono: true,
          rows: [
            ["project_project_views.xml", "Smart button in <code>button_box</code>", "“Remaining to Schedule” statinfo button; hidden when count = 0; gated to planning employees."],
            ["planning_allocation_views.xml", "“Planning Consumption” group + 2 list columns", "Shows planned charge / already planned / remaining on the allocation."],
            ["planning_slot_views.xml", "<code>allocation_id</code> in list + form", "Exposes Source Allocation in the shift dialog (<code>no_create</code>)."],
            ["crm_lead_views.xml", "2 columns in both allocation sub-lists", "Adds already-planned + remaining to the pre-planning lead view."],
            ["acme_planning_views.xml", "invisible <code>allocation_id</code>", "Makes the link available to the gantt-style planning surface."],
          ],
        },
        {
          c: "code",
          path: "project_project_views.xml · smart button",
          lang: "markup",
          code: R`<button class="oe_stat_button" type="object"
        name="action_open_planning_pool_items"
        icon="fa-calendar-check-o"
        groups="acme_planning.group_planning_employee"
        invisible="planning_pool_item_count == 0">
    <field name="planning_pool_item_count" widget="statinfo" string="Remaining to Schedule"/>
</button>`,
        },
      ],
    },

    /* ---- wizards ---- */
    {
      id: "wizards",
      nav: { label: "Wizards", icon: "gear", group: "Surface" },
      heading: { icon: "gear", title: "Wizards" },
      blocks: [
        {
          c: "cards",
          cols: 1,
          items: [
            { html: R`<p style="margin-top:0"><b>No new wizards in this PR.</b> Deliberate, and worth recording.</p>
              <p class="fnote">Pool items are consumed <b>manually</b>: a planner sets <code>Source Allocation</code> in the shift dialog.
              ADR 0008 defers automatic slot generation to a future wizard (#62), which must create draft slots <b>through the same
              <code>allocation_id</code> link</b> rather than inventing a second consumption path.</p>` },
          ],
        },
      ],
    },

    /* ---- security ---- */
    {
      id: "security",
      nav: { label: "Security", icon: "shield-lock", group: "Surface" },
      heading: { icon: "shield-lock", title: "Security linked to the model" },
      files: [
        { status: "M", path: "addons/acme_planning/security/ir.model.access.csv" },
        { status: "M", path: "addons/acme_planning/security/planning_rules.xml" },
      ],
      blocks: [
        { c: "intro", html: R`Two layers, both read-only: model-level ACLs and row-level company record rules. A derived lens should never be writable.` },
        { c: "h3", text: "Access rights — ir.model.access.csv" },
        {
          c: "matrix",
          head: ["ACL · group", "read", "write", "create", "unlink"],
          rows: [
            ['planning.pool.item · group_planning_employee', '<span class="yes">✓</span>', '<span class="no">—</span>', '<span class="no">—</span>', '<span class="no">—</span>'],
            ['planning.pool.item · group_planning_planner', '<span class="yes">✓</span>', '<span class="no">—</span>', '<span class="no">—</span>', '<span class="no">—</span>'],
            ['planning.pool.item · group_planning_manager', '<span class="yes">✓</span>', '<span class="no">—</span>', '<span class="no">—</span>', '<span class="no">—</span>'],
          ],
        },
        { c: "h3", text: "Record rules — planning_rules.xml" },
        { c: "p", html: R`One company rule per group, all read-only, same domain — visible when the item's company is among the user's allowed companies (or company-less):` },
        {
          c: "code",
          path: "security/planning_rules.xml · pool item rules (×3, employee shown)",
          lang: "markup",
          collapsed: false,
          code: R`<record id="planning_pool_item_rule_employee_company" model="ir.rule">
    <field name="name">Planning Pool Item: employee company items</field>
    <field name="model_id" ref="model_planning_pool_item"/>
    <field name="domain_force">[('company_id', 'in', company_ids + [False])]</field>
    <field name="groups" eval="[(4, ref('group_planning_employee'))]"/>
    <field name="perm_read" eval="True"/>
    <field name="perm_write" eval="False"/>
    <field name="perm_create" eval="False"/>
    <field name="perm_unlink" eval="False"/>
</record>`,
        },
        { c: "callout", tone: "key", html: R`<b>Multi-company integrity, three ways:</b> <code>check_company=True</code> on the slot link +
          <code>_check_company_auto</code> on the slot + these <code>company_id in company_ids + [False]</code> rules.` },
      ],
    },

    /* ---- tests (TLDR — never the diff; the reviewer wants what each test proves) ---- */
    {
      id: "tests",
      nav: { label: "Tests", icon: "beaker", group: "Quality" },
      heading: { icon: "beaker", title: "Tests — what they prove" },
      files: [{ status: "A", path: "addons/acme_planning/tests/test_planning_pool_item.py" }],
      blocks: [
        { c: "intro", html: R`281 lines of tests, summarized: one card per test with the scenario and the key assertions. Open the diff only if a card raises a question.` },
        {
          c: "tests",
          items: [
            {
              name: "test_pool_grain",
              kind: "unit",
              ref: "tests/test_planning_pool_item.py",
              scenario: R`Creates allocations in every state (draft, converted, cancelled) plus one archived. Reads the pool view.`,
              asserts: [
                R`Only <b>active + Converted</b> allocations produce a pool item.`,
                R`One row per allocation — never per person×month.`,
              ],
            },
            {
              name: "test_live_consumption",
              kind: "unit",
              scenario: R`Links slots to a 40 h allocation, then walks the full lifecycle: <b>create → resize → reassign → cancel → unlink</b>.`,
              asserts: [
                R`Each step moves <code>placed_hours</code> / <code>remaining_hours</code> immediately — nothing is stored or decremented.`,
                R`A cancelled slot stops counting; unlink restores the remaining charge.`,
              ],
            },
            {
              name: "test_overconsumption_floor",
              kind: "unit",
              scenario: R`Plans 48 h of slots against a 40 h allocation.`,
              asserts: [R`<code>remaining_hours</code> floors at <b>0.0</b> — never negative in the pool.`],
            },
            {
              name: "test_allocation_link_constraint",
              kind: "unit",
              scenario: R`Tries to point <code>planning.slot.allocation_id</code> at a forecast allocation, then at an archived one, via <code>write()</code> (not the UI).`,
              asserts: [R`Both writes raise <code>ValidationError</code> — the picker domain is defended by <code>@api.constrains</code>.`],
            },
          ],
        },
      ],
    },

    /* ---- translations (counts, not diffs — .po churn carries no review signal) ---- */
    {
      id: "i18n",
      nav: { label: "Translations", icon: "globe", group: "Quality" },
      heading: { icon: "globe", title: "Translations" },
      files: [
        { status: "M", path: "addons/acme_planning/i18n/fr.po" },
        { status: "M", path: "addons/acme_planning/i18n/acme_planning.pot" },
      ],
      blocks: [
        { c: "intro", html: R`201 diff lines collapse to one fact: every new label shipped with its French translation in the same PR. Nothing here needs line-by-line review.` },
        {
          c: "i18n",
          rows: [
            { path: "i18n/fr.po", status: "M", lang: "fr", add: 101, del: 0, entries: { new: 31, updated: 2 } },
            { path: "i18n/acme_planning.pot", status: "M", add: 100, del: 0, entries: { new: 31 }, note: "regenerated from source — in sync" },
          ],
          note: R`31 new entries = the pool item fields, view labels and the two smart buttons. The 2 updated French strings fix wording on existing allocation labels.`,
        },
      ],
    },

    /* ---- concepts ---- */
    {
      id: "concepts",
      nav: { label: "Patterns", icon: "light-bulb", group: "Deep dive" },
      heading: { icon: "light-bulb", title: "Patterns worth stealing" },
      blocks: [
        { c: "intro", html: R`The transferable techniques in this PR — what to reuse next time, each tied to where it lives in the diff.` },
        {
          c: "patterns",
          items: [
            { icon: "database", term: "SQL-view model", html: R`<code>_auto = False</code> + <code>init()</code> with <code>CREATE OR REPLACE VIEW</code>: a model that's a query, not a table.`, ref: "planning_pool_item.py" },
            { icon: "rows", term: "Derived readings", html: R`Non-stored <code>compute</code> fields with precise depends on <code>...slot_ids.allocated_hours</code> &amp; <code>.state</code> → live, never desynced.`, ref: "@api.depends" },
            { icon: "columns", term: "Grouped aggregation", html: R`One <code>_read_group</code> over slots, keyed by allocation, shared by both models via a single helper.`, ref: "allocated_hours:sum" },
            { icon: "shield-lock", term: "check_company trio", html: R`<code>check_company=True</code> + <code>_check_company_auto</code> + <code>company_id in company_ids + [False]</code> rules.`, ref: "multi-company" },
            { icon: "eye", term: "Smart button", html: R`Computed count field + a <code>statinfo</code> button + a window action injecting a domain and a group-by context.`, ref: "project_project.py" },
            { icon: "law", term: "Domain + constraint", html: R`Field <code>domain</code> filters the picker; <code>@api.constrains</code> defends the same rule against non-UI writes.`, ref: "defense-in-depth" },
            { icon: "book", term: "i18n discipline", html: R`Every new label landed in <code>fr.po</code> and the <code>.pot</code> in the same diff — French is a deliverable, not a follow-up.`, ref: "i18n/" },
            { icon: "git-branch", term: "Grain as a decision", html: R`One row per <i>allocation</i> (not person×month), recorded in the ADR as a constraint on the follow-up issues #60/#62.`, ref: "ADR 0008" },
          ],
        },
      ],
    },

    /* ---- files changed ---- */
    {
      id: "files",
      nav: { label: "Files changed", icon: "file-diff", group: "Deep dive" },
      heading: { icon: "file-diff", title: R`Files changed <span class="tag" style="font-size:13px">21 files</span>` },
      blocks: [
        { c: "files" },
      ],
    },
  ],

  footerHtml: R`Generated walkthrough of <b>Add live planning pool items</b> (#96) ·
    <span class="mono">feature/59…</span> → <span class="mono">dev</span>. Read-only artifact.`,
};

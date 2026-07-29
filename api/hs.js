// Smart Board — HubSpot proxy (Vercel serverless function)
// ------------------------------------------------------------------
// The public board calls window.cowork.callMcpTool(tool, args) exactly as it
// did inside Cowork. The browser POSTs {tool, args} here; this function holds
// the HubSpot Private App token (server-side only) and emulates the four MCP
// tools it used, translating each into standard HubSpot CRM v3/v4 API calls.
//
//   query_crm_data     -> ticket/task datasets, returned as "Dataset TSV:" text
//   search_crm_objects -> ticket search + association-based note lookup
//   get_crm_objects    -> ticket batch read (description content)
//   manage_crm_objects -> PATCH updates + create-with-association (tasks/notes)
//
// Auth: every request must carry the shared passcode in the x-board-pass header
// (matched against BOARD_PASSCODE). The HubSpot token never reaches the browser.

const HS_BASE = "https://api.hubapi.com";
const OWNER = "165370772"; // Raj Kumar — portal 242531638 (na2)

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ isError: true, content: [{ type: "text", text: "POST only" }] });
    return;
  }

  // ---- passcode gate ----
  const expected = process.env.BOARD_PASSCODE || "";
  if (!expected) {
    res.status(500).json({ isError: true, content: [{ type: "text", text: "Server misconfigured: BOARD_PASSCODE is not set." }] });
    return;
  }
  const pass = req.headers["x-board-pass"] || "";
  // Forgiving compare: ignore case, spaces, and dash style (hyphen / en-dash /
  // em-dash / minus). Passcodes shared via chat or docs often get "smart-dashed"
  // or auto-capitalized, which otherwise causes false "wrong passcode" failures.
  const normPass = (s) => String(s || "").toLowerCase().replace(/[\s\-‐-―−]/g, "");
  if (normPass(pass) !== normPass(expected)) {
    res.status(401).json({ isError: true, content: [{ type: "text", text: "Unauthorized" }] });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const tool = String(body.tool || "");
  const args = body.args || {};

  // Passcode-only check used by the gate — does not require the HubSpot token.
  if (tool === "ping") { res.status(200).json({ ok: true }); return; }

  const token = process.env.HUBSPOT_TOKEN || "";
  if (!token) {
    res.status(500).json({ isError: true, content: [{ type: "text", text: "Server misconfigured: HUBSPOT_TOKEN is not set." }] });
    return;
  }

  try {

    let out;
    if (tool.endsWith("query_crm_data")) out = await handleQuery(token, args);
    else if (tool.endsWith("search_crm_objects")) out = await handleSearch(token, args);
    else if (tool.endsWith("get_crm_objects")) out = await handleGet(token, args);
    else if (tool.endsWith("manage_crm_objects")) out = await handleManage(token, args);
    else if (tool.endsWith("mirror_to_deal")) out = await handleMirror(token, args);
    else if (tool.endsWith("backfill_ticket")) out = await handleBackfillTicket(token, args);
    else out = { isError: true, content: [{ type: "text", text: "Unknown tool: " + tool }] };

    res.status(200).json(out);
  } catch (e) {
    // Return as an MCP-style tool error (HTTP 200) so the board's own retry /
    // degradation handling kicks in rather than surfacing a raw 500.
    res.status(200).json({ isError: true, content: [{ type: "text", text: "HubSpot error: " + (e && e.message ? e.message : String(e)) }] });
  }
};

// ---------------------------------------------------------------- HubSpot fetch
async function hs(token, method, path, payload) {
  const r = await fetch(HS_BASE + path, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
  if (!r.ok) {
    const msg = (j && (j.message || j.error)) || text || ("HTTP " + r.status);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return j;
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// TSV cell helpers — the board parses enum values via a trailing "(CODE)" and
// dates via a leading YYYY-MM-DD, so we shape values to match.
function cell(v) { if (v == null) return ""; return String(v).replace(/[\t\r\n]+/g, " ").trim(); }
function enumCell(v) { if (v == null || v === "") return ""; return "(" + String(v).replace(/[()\t\r\n]/g, "") + ")"; }
function dateCell(v) {
  if (v == null || v === "") return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;         // already ISO / date
  if (/^\d+$/.test(s)) { const d = new Date(Number(s)); if (!isNaN(d)) return d.toISOString(); } // epoch ms
  const d = new Date(s); if (!isNaN(d)) return d.toISOString();
  return "";
}

// ---------------------------------------------------------------- tickets read
const TICKET_PROPS = ["subject", "hs_ticket_priority", "hs_pipeline_stage", "createdate", "closed_date", "hs_lastmodifieddate", "hs_nextactivitydate", "ticket_type"];

async function fetchOwnerTickets(token) {
  let after;
  const all = [];
  for (let i = 0; i < 50; i++) {
    const payload = {
      filterGroups: [{ filters: [{ propertyName: "hubspot_owner_id", operator: "EQ", value: OWNER }] }],
      properties: TICKET_PROPS,
      limit: 100,
    };
    if (after) payload.after = after;
    const j = await hs(token, "POST", "/crm/v3/objects/tickets/search", payload);
    (j.results || []).forEach((r) => all.push(r));
    const next = j.paging && j.paging.next && j.paging.next.after;
    if (!next) break;
    after = next;
  }
  return all;
}

// tickets -> associated deal names (the board's "hotel" column)
async function dealNamesForTickets(token, ticketIds) {
  const map = {};
  if (!ticketIds.length) return map;
  const dealByTicket = {};
  const dealIds = new Set();
  for (const chunk of chunks(ticketIds, 100)) {
    const j = await hs(token, "POST", "/crm/v4/associations/tickets/deals/batch/read", { inputs: chunk.map((id) => ({ id: String(id) })) });
    (j.results || []).forEach((r) => {
      const from = r.from && r.from.id;
      const first = r.to && r.to[0];
      const to = first && (first.toObjectId || first.id);
      if (from && to) { dealByTicket[from] = String(to); dealIds.add(String(to)); }
    });
  }
  const nameById = {};
  for (const chunk of chunks([...dealIds], 100)) {
    if (!chunk.length) continue;
    const j = await hs(token, "POST", "/crm/v3/objects/deals/batch/read", { properties: ["dealname"], inputs: chunk.map((id) => ({ id: String(id) })) });
    (j.results || []).forEach((d) => { nameById[d.id] = (d.properties && d.properties.dealname) || ""; });
  }
  for (const tid of Object.keys(dealByTicket)) map[tid] = nameById[dealByTicket[tid]] || "";
  return map;
}

async function ticketsTSV(token) {
  const tickets = await fetchOwnerTickets(token);
  const ids = tickets.map((t) => t.id);
  const dealName = await dealNamesForTickets(token, ids);
  const headers = ["[hs_object_id]", "[subject]", "[hs_ticket_priority]", "[hs_pipeline_stage]", "[createdate]", "[closed_date]", "[hs_lastmodifieddate]", "[hs_nextactivitydate]", "[ticket_type]", "[dealname]"];
  const rows = tickets.map((t) => {
    const p = t.properties || {};
    return [
      t.id,
      cell(p.subject),
      enumCell(p.hs_ticket_priority),
      enumCell(p.hs_pipeline_stage),
      dateCell(p.createdate),
      dateCell(p.closed_date),
      dateCell(p.hs_lastmodifieddate),
      dateCell(p.hs_nextactivitydate),
      cell(p.ticket_type),
      cell(dealName[t.id] || ""),
    ].join("\t");
  });
  return "Dataset TSV:\n" + headers.join("\t") + "\n" + rows.join("\n");
}

// tasks on this owner's tickets: columns [task id][subject][status][due][ticket id]
async function tasksTSV(token) {
  const tickets = await fetchOwnerTickets(token);
  const ticketIds = tickets.map((t) => t.id);
  const taskToTicket = {};
  const taskIds = new Set();
  for (const chunk of chunks(ticketIds, 100)) {
    const j = await hs(token, "POST", "/crm/v4/associations/tickets/tasks/batch/read", { inputs: chunk.map((id) => ({ id: String(id) })) });
    (j.results || []).forEach((r) => {
      const from = r.from && r.from.id;
      (r.to || []).forEach((to) => {
        const tid = String(to.toObjectId || to.id);
        if (tid && from) { taskToTicket[tid] = String(from); taskIds.add(tid); }
      });
    });
  }
  const taskProps = {};
  for (const chunk of chunks([...taskIds], 100)) {
    if (!chunk.length) continue;
    const j = await hs(token, "POST", "/crm/v3/objects/tasks/batch/read", { properties: ["hs_task_subject", "hs_task_status", "hs_timestamp"], inputs: chunk.map((id) => ({ id: String(id) })) });
    (j.results || []).forEach((t) => { taskProps[t.id] = t.properties || {}; });
  }
  const headers = ["[hs_object_id]", "[hs_task_subject]", "[hs_task_status]", "[hs_timestamp]", "[hs_object_id]"];
  const rows = [];
  for (const taskId of Object.keys(taskToTicket)) {
    const p = taskProps[taskId] || {};
    rows.push([taskId, cell(p.hs_task_subject), enumCell(p.hs_task_status), dateCell(p.hs_timestamp), taskToTicket[taskId]].join("\t"));
  }
  return "Dataset TSV:\n" + headers.join("\t") + "\n" + rows.join("\n");
}

async function handleQuery(token, args) {
  const sql = String((args && args.sql) || "");
  const text = /FROM\s+TASK/i.test(sql) ? await tasksTSV(token) : await ticketsTSV(token);
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------- search
function findAssociatedWith(filterGroups) {
  for (const g of filterGroups || []) {
    if (g && Array.isArray(g.associatedWith) && g.associatedWith.length) {
      const a = g.associatedWith[0];
      return { parentType: a.objectType, ids: (a.objectIdValues || []).map(String) };
    }
  }
  return null;
}

async function associatedObjects(token, parentType, parentIds, childType, props) {
  const childIds = new Set();
  for (const chunk of chunks(parentIds, 100)) {
    const j = await hs(token, "POST", "/crm/v4/associations/" + parentType + "/" + childType + "/batch/read", { inputs: chunk.map((id) => ({ id: String(id) })) });
    (j.results || []).forEach((r) => {
      (r.to || []).forEach((to) => { const cid = String(to.toObjectId || to.id); if (cid) childIds.add(cid); });
    });
  }
  const properties = props && props.length ? props : ["hs_note_body", "hs_body_preview", "hs_timestamp", "hs_createdate"];
  const out = [];
  for (const chunk of chunks([...childIds], 100)) {
    if (!chunk.length) continue;
    const j = await hs(token, "POST", "/crm/v3/objects/" + childType + "/batch/read", { properties, inputs: chunk.map((id) => ({ id: String(id) })) });
    (j.results || []).forEach((o) => out.push({ id: o.id, properties: o.properties || {} }));
  }
  out.sort((a, b) => {
    const av = Date.parse(a.properties.hs_createdate || a.properties.hs_timestamp || 0) || 0;
    const bv = Date.parse(b.properties.hs_createdate || b.properties.hs_timestamp || 0) || 0;
    return bv - av;
  });
  return out;
}

async function handleSearch(token, args) {
  const objectType = args.objectType || "";
  const filterGroups = args.filterGroups || [];
  const props = args.properties || [];
  const assoc = findAssociatedWith(filterGroups);
  if (assoc) {
    const results = await associatedObjects(token, assoc.parentType, assoc.ids, objectType, props);
    return { structuredContent: { results } };
  }
  const payload = { filterGroups, properties: props, limit: args.limit || 100 };
  if (args.sorts) payload.sorts = args.sorts;
  if (args.after) payload.after = args.after;
  const j = await hs(token, "POST", "/crm/v3/objects/" + objectType + "/search", payload);
  return { structuredContent: { results: (j.results || []).map((r) => ({ id: r.id, properties: r.properties })) } };
}

// ---------------------------------------------------------------- get (batch read)
async function handleGet(token, args) {
  const objectType = args.objectType || "tickets";
  const ids = (args.objectIds || []).map(String);
  const props = args.properties || [];
  const j = await hs(token, "POST", "/crm/v3/objects/" + objectType + "/batch/read", { properties: props, inputs: ids.map((id) => ({ id })) });
  const objects = (j.results || []).map((o) => ({ id: o.id, properties: o.properties || {} }));
  return { structuredContent: { objects } };
}

// ---------------------------------------------------------------- writes
async function handleManage(token, args) {
  if (args.updateRequest) {
    const objs = args.updateRequest.objects || [];
    let updated = 0, failed = 0, message = "";
    for (const o of objs) {
      try {
        await hs(token, "PATCH", "/crm/v3/objects/" + o.objectType + "/" + o.objectId, { properties: o.properties || {} });
        updated++;
      } catch (e) { failed++; message = e && e.message ? e.message : String(e); }
    }
    return { structuredContent: { message, updateResults: { summary: { updated, created: 0, failed } } } };
  }
  if (args.createRequest) {
    const objs = args.createRequest.objects || [];
    const results = [];
    let created = 0, failed = 0, message = "";
    for (const o of objs) {
      try {
        const properties = Object.assign({}, o.properties || {});
        // HubSpot Tasks require hs_timestamp on creation; the board doesn't send
        // one for a plain checklist task, so default it to now.
        if (o.objectType === "tasks" && !properties.hs_timestamp) properties.hs_timestamp = String(Date.now());
        const c = await hs(token, "POST", "/crm/v3/objects/" + o.objectType, { properties });
        const newId = c && c.id;
        for (const a of o.associations || []) {
          try {
            await hs(token, "PUT", "/crm/v4/objects/" + o.objectType + "/" + newId + "/associations/default/" + a.targetObjectType + "/" + a.targetObjectId, {});
          } catch (e) { /* object created; association is best-effort */ }
        }
        results.push({ object: { id: String(newId) } });
        created++;
      } catch (e) { failed++; message = e && e.message ? e.message : String(e); }
    }
    return { structuredContent: { message, createResults: { summary: { created, failed }, results } } };
  }
  return { isError: true, content: [{ type: "text", text: "Unsupported manage request" }] };
}

// ---------------------------------------------------------------- deal-note composition
const STAGE_LABELS = { "1": "New", "3825884908": "In-Progress", "3": "Waiting on us", "3825884907": "Hold", "2": "Waiting on Customer", "4": "Closed" };
const PRI_LABELS = { URGENT: "Urgent", HIGH: "High", MEDIUM: "Medium", LOW: "Low", NONE: "No priority" };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(ts) { const s = String(ts || "").slice(0, 10); const p = s.split("-"); if (p.length !== 3) return s; return String(+p[2]) + " " + (MON[(+p[1]) - 1] || p[1]) + " " + p[0]; }
function escHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
function stripHtml(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }

async function assocIds(token, fromType, toType, id) {
  const j = await hs(token, "POST", "/crm/v4/associations/" + fromType + "/" + toType + "/batch/read", { inputs: [{ id: String(id) }] });
  const ids = [];
  (j.results || []).forEach((r) => (r.to || []).forEach((to) => { const x = String(to.toObjectId || to.id); if (x) ids.push(x); }));
  return ids;
}

// Reads a ticket's state (subject, type, priority, stage, tasks, deals, and
// optionally its full note history) in one place, so every deal note is built
// from the same data.
async function gatherTicket(token, ticketId, opts) {
  const withNotes = !!(opts && opts.withNotes);
  const tr = await hs(token, "POST", "/crm/v3/objects/tickets/batch/read", { properties: ["subject", "hs_ticket_priority", "hs_pipeline_stage", "ticket_type"], inputs: [{ id: ticketId }] });
  const tp = (tr.results && tr.results[0] && tr.results[0].properties) || {};
  const g = {
    subject: tp.subject || "(no subject)",
    type: tp.ticket_type || "—",
    priKey: PRI_LABELS[tp.hs_ticket_priority] ? tp.hs_ticket_priority : "NONE",
    stageKey: STAGE_LABELS[tp.hs_pipeline_stage] ? tp.hs_pipeline_stage : "1",
    tasks: [], notes: [], dealIds: [],
  };
  try {
    const taskIds = await assocIds(token, "tickets", "tasks", ticketId);
    if (taskIds.length) {
      const tb = await hs(token, "POST", "/crm/v3/objects/tasks/batch/read", { properties: ["hs_task_subject", "hs_task_status"], inputs: taskIds.map((id) => ({ id })) });
      g.tasks = (tb.results || []).map((t) => ({ title: (t.properties && t.properties.hs_task_subject) || "Task", done: (t.properties && t.properties.hs_task_status) === "COMPLETED" }));
    }
  } catch (e) { /* tasks optional */ }
  if (withNotes) {
    try {
      const noteIds = await assocIds(token, "tickets", "notes", ticketId);
      if (noteIds.length) {
        const nb = await hs(token, "POST", "/crm/v3/objects/notes/batch/read", { properties: ["hs_note_body", "hs_createdate"], inputs: noteIds.map((id) => ({ id })) });
        g.notes = (nb.results || []).map((n) => ({ body: stripHtml(n.properties && n.properties.hs_note_body), ts: (n.properties && n.properties.hs_createdate) || "" })).filter((n) => n.body);
        g.notes.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
      }
    } catch (e) { /* notes optional */ }
  }
  g.dealIds = await assocIds(token, "tickets", "deals", ticketId);
  return g;
}

// Builds the HTML note body. `heading` differs per use (live update vs snapshot);
// `action` is the "what changed" line; `highlightNote` is a single note to feature.
function buildDealNote(g, opts) {
  const o = opts || {};
  const priLabel = PRI_LABELS[g.priKey] || PRI_LABELS.NONE;
  const stgLabel = STAGE_LABELS[g.stageKey] || "New";
  let h = "";
  h += "<p><strong>" + escHtml(o.heading || "Ticket Update") + "</strong></p>";
  h += "<p><strong>" + escHtml(g.subject) + "</strong></p>";
  h += "<hr>";
  if (o.action) h += "<p><strong>Update:</strong> " + escHtml(o.action) + "</p>";
  h += "<p><strong>Status:</strong> " + escHtml(stgLabel) +
       "<br><strong>Priority:</strong> " + escHtml(priLabel) +
       "<br><strong>Type:</strong> " + escHtml(g.type) + "</p>";
  if (o.highlightNote) h += "<p><strong>Note added:</strong><br>" + escHtml(o.highlightNote) + "</p>";
  if (g.tasks && g.tasks.length) {
    const done = g.tasks.filter((x) => x.done).length;
    h += "<p><strong>Tasks &mdash; " + done + " of " + g.tasks.length + " complete</strong></p><ul>";
    g.tasks.forEach((x) => { h += "<li>" + escHtml(x.title) + " &mdash; " + (x.done ? "Complete" : "Pending") + "</li>"; });
    h += "</ul>";
  }
  if (g.notes && g.notes.length) {
    h += "<p><strong>Ticket Notes</strong></p><ul>";
    g.notes.forEach((n) => { const d = n.ts ? (escHtml(fmtDate(n.ts)) + " &mdash; ") : ""; h += "<li>" + d + escHtml(n.body) + "</li>"; });
    h += "</ul>";
  }
  h += "<hr><p><em>Logged from the Smart Board &middot; Raj</em></p>";
  return h;
}

async function postDealNote(token, dealIds, body) {
  let mirrored = 0, message = "";
  for (const dealId of dealIds) {
    try {
      const c = await hs(token, "POST", "/crm/v3/objects/notes", { properties: { hs_note_body: body, hs_timestamp: String(Date.now()), hubspot_owner_id: OWNER } });
      await hs(token, "PUT", "/crm/v4/objects/notes/" + (c && c.id) + "/associations/default/deals/" + dealId, {});
      mirrored++;
    } catch (e) { message = e && e.message ? e.message : String(e); }
  }
  return { mirrored, message };
}

// Live mirror: {ticketId, action, note} → posts a "what just happened" note to the deal.
async function handleMirror(token, args) {
  const ticketId = String((args && args.ticketId) || "");
  if (!ticketId) return { structuredContent: { mirrored: 0 } };
  const g = await gatherTicket(token, ticketId, { withNotes: false });
  const body = buildDealNote(g, { heading: "Ticket update", action: (args && args.action) || "", highlightNote: (args && args.note) || "" });
  const { mirrored, message } = await postDealNote(token, g.dealIds, body);
  return { structuredContent: { mirrored, dealIds: g.dealIds, message } };
}

// Backfill: {ticketId, dryRun} → posts a full "current state" snapshot (incl. all notes).
async function handleBackfillTicket(token, args) {
  const ticketId = String((args && args.ticketId) || "");
  const dryRun = !!(args && args.dryRun);
  if (!ticketId) return { structuredContent: { mirrored: 0, dealIds: [] } };
  const g = await gatherTicket(token, ticketId, { withNotes: true });
  const body = buildDealNote(g, { heading: "Ticket Summary — Current State" });
  if (dryRun) return { structuredContent: { dryRun: true, dealIds: g.dealIds, body } };
  const { mirrored, message } = await postDealNote(token, g.dealIds, body);
  return { structuredContent: { mirrored, dealIds: g.dealIds, message } };
}

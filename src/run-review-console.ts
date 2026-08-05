export function runReviewConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Operator Run Review</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fa;
      --panel: #ffffff;
      --ink: #182230;
      --muted: #667085;
      --line: #d0d7e2;
      --blue: #175cd3;
      --cyan: #0e7490;
      --green: #067647;
      --amber: #b54708;
      --red: #b42318;
      --slate: #344054;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }
    header {
      background: #101828;
      border-bottom: 1px solid #263347;
      color: #f8fafc;
    }
    .topbar {
      max-width: 1280px;
      margin: 0 auto;
      padding: 16px 22px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    h1 {
      margin: 0;
      font-size: 21px;
      font-weight: 730;
      letter-spacing: 0;
    }
    .token {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: min(520px, 100%);
    }
    input {
      width: 100%;
      min-width: 180px;
      border: 1px solid #475467;
      border-radius: 6px;
      background: #ffffff;
      color: #101828;
      padding: 9px 10px;
      font: inherit;
    }
    button {
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 9px 11px;
      font: inherit;
      font-weight: 720;
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary { background: var(--blue); color: #ffffff; }
    button.secondary { background: #e6edf7; color: #1d2939; border-color: #c6d3e1; }
    main {
      max-width: 1280px;
      margin: 0 auto;
      padding: 18px 22px 34px;
      display: grid;
      grid-template-columns: minmax(330px, 0.82fr) minmax(440px, 1.18fr);
      gap: 16px;
    }
    section {
      min-width: 0;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .section-head {
      min-height: 56px;
      border-bottom: 1px solid var(--line);
      padding: 13px 15px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    h2 {
      margin: 0;
      font-size: 15px;
      letter-spacing: 0;
    }
    .muted { color: var(--muted); }
    .count { color: var(--muted); font-size: 13px; }
    .queue {
      display: grid;
      max-height: calc(100vh - 138px);
      overflow: auto;
    }
    .row {
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
      color: inherit;
      width: 100%;
      padding: 13px 15px;
      text-align: left;
      display: grid;
      gap: 8px;
    }
    .row:hover, .row.active { background: #eef6ff; }
    .row:last-child { border-bottom: 0; }
    .row-title {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      font-weight: 760;
      line-height: 1.25;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 23px;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 12px;
      font-weight: 760;
      background: #eef2f6;
      color: var(--slate);
      white-space: nowrap;
    }
    .chip.sev { background: #fef3f2; color: var(--red); }
    .chip.safe_recommendation { background: #ecfdf3; color: var(--green); }
    .chip.approval_required { background: #fff7ed; color: var(--amber); }
    .chip.blocked, .chip.unsafe { background: #fef3f2; color: var(--red); }
    .chip.completed, .chip.valid { background: #ecfdf3; color: var(--green); }
    .detail {
      padding: 15px;
      display: grid;
      gap: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 11px;
    }
    .field {
      border-bottom: 1px solid var(--line);
      padding-bottom: 9px;
      min-width: 0;
    }
    .label {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 760;
      margin-bottom: 5px;
      text-transform: uppercase;
    }
    .value {
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    .panel-title {
      padding: 10px 12px;
      background: #f8fafc;
      border-bottom: 1px solid var(--line);
      font-weight: 760;
    }
    .panel-body {
      padding: 11px 12px;
      display: grid;
      gap: 9px;
    }
    .list {
      margin: 0;
      padding-left: 19px;
      display: grid;
      gap: 7px;
    }
    pre {
      margin: 0;
      padding: 11px;
      border-radius: 6px;
      background: #111827;
      color: #d1fae5;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.45;
    }
    .empty {
      padding: 28px 15px;
      color: var(--muted);
    }
    .error {
      color: var(--red);
      font-weight: 700;
    }
    @media (max-width: 900px) {
      .topbar { flex-direction: column; align-items: flex-start; }
      main { grid-template-columns: 1fr; padding: 14px; }
      .grid { grid-template-columns: 1fr; }
      .queue { max-height: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <h1>Operator Run Review</h1>
      <div class="token">
        <input id="token" type="password" autocomplete="off" placeholder="OPERATOR_READ_TOKEN">
        <button id="save" class="primary" type="button">Load</button>
        <button id="clear" class="secondary" type="button">Clear</button>
      </div>
    </div>
  </header>
  <main>
    <section>
      <div class="section-head">
        <h2>Runs</h2>
        <span class="count" id="summary"></span>
      </div>
      <div id="runs" class="queue"><div class="empty">Enter token to load runs.</div></div>
    </section>
    <section>
      <div class="section-head">
        <h2>Review</h2>
        <button id="refresh" class="secondary" type="button">Refresh</button>
      </div>
      <div id="detail" class="detail"><div class="empty">Select a run.</div></div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("token");
    const runsEl = document.getElementById("runs");
    const detailEl = document.getElementById("detail");
    const summaryEl = document.getElementById("summary");
    let runs = [];
    let selectedRunId = "";

    tokenInput.value = sessionStorage.getItem("operatorReadToken") || "";
    document.getElementById("save").addEventListener("click", () => {
      sessionStorage.setItem("operatorReadToken", tokenInput.value);
      loadRuns();
    });
    document.getElementById("clear").addEventListener("click", () => {
      sessionStorage.removeItem("operatorReadToken");
      tokenInput.value = "";
      runs = [];
      selectedRunId = "";
      renderRuns();
      detailEl.innerHTML = '<div class="empty">Select a run.</div>';
    });
    document.getElementById("refresh").addEventListener("click", loadRuns);

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function authHeaders() {
      const token = tokenInput.value || sessionStorage.getItem("operatorReadToken") || "";
      return token ? { Authorization: "Bearer " + token } : {};
    }

    async function loadRuns() {
      runsEl.innerHTML = '<div class="empty">Loading runs...</div>';
      const response = await fetch("/api/runs?limit=50", { headers: authHeaders() });
      if (!response.ok) {
        runsEl.innerHTML = '<div class="empty error">Unable to load runs: ' + response.status + '</div>';
        summaryEl.textContent = "";
        return;
      }
      const data = await response.json();
      runs = data.runs || [];
      summaryEl.textContent = data.summary ? data.summary.total + " retained" : "";
      if (!runs.some((run) => run.run_id === selectedRunId)) {
        selectedRunId = runs.length > 0 ? runs[0].run_id : "";
      }
      renderRuns();
      if (selectedRunId) {
        await loadReview(selectedRunId);
      }
    }

    function renderRuns() {
      if (runs.length === 0) {
        runsEl.innerHTML = '<div class="empty">No retained runs.</div>';
        summaryEl.textContent = "";
        return;
      }
      runsEl.innerHTML = runs.map((run) => {
        const active = run.run_id === selectedRunId ? " active" : "";
        return '<button class="row' + active + '" type="button" data-id="' + escapeHtml(run.run_id) + '">' +
          '<div class="row-title"><span>' + escapeHtml(run.incident_title || run.incident_id) + '</span><span class="chip sev">' + escapeHtml(run.severity) + '</span></div>' +
          '<div class="meta">' + escapeHtml(run.service) + ' / ' + escapeHtml(run.incident_id) + '</div>' +
          '<div class="chips">' +
            chip(run.run_status) +
            chip(run.validation_status) +
            chip(run.safety_status || "not_available") +
          '</div>' +
          '<div class="meta">' + escapeHtml(run.created_at) + '</div>' +
        '</button>';
      }).join("");
      for (const row of runsEl.querySelectorAll(".row")) {
        row.addEventListener("click", async () => {
          selectedRunId = row.getAttribute("data-id") || "";
          renderRuns();
          await loadReview(selectedRunId);
        });
      }
    }

    async function loadReview(runId) {
      detailEl.innerHTML = '<div class="empty">Loading review...</div>';
      const response = await fetch("/api/runs/" + encodeURIComponent(runId), { headers: authHeaders() });
      if (!response.ok) {
        detailEl.innerHTML = '<div class="empty error">Unable to load review: ' + response.status + '</div>';
        return;
      }
      renderReview(await response.json());
    }

    function renderReview(data) {
      const run = data.run || {};
      const review = data.review || {};
      const decision = review.decision || {};
      const mitigation = review.mitigation_control || {};
      const evidence = (data.evidence_snapshot && data.evidence_snapshot.evidence) || [];
      detailEl.innerHTML =
        '<div class="grid">' +
          field("Incident", run.incident_title || run.incident_id) +
          field("Service", run.service) +
          field("Severity", run.severity) +
          field("Safety", run.safety_status) +
          field("Run Status", run.run_status) +
          field("Created", run.created_at) +
        '</div>' +
        panel("RCA Hypothesis", renderHypotheses(review.explanation)) +
        panel("Decision", '<div class="chips">' + chip(decision.incident_class) + chip(decision.next_action) + chip("confidence " + (decision.confidence ?? "n/a")) + '</div>' + list("Verification", decision.verification_plan)) +
        panel("Mitigation", '<div class="chips">' + chip(mitigation.status) + chip(mitigation.approval_required ? "approval required" : "no approval") + '</div>' + field("Reason", mitigation.reason)) +
        panel("Evidence", evidence.slice(0, 8).map(renderEvidence).join("") || '<div class="muted">No evidence snapshot.</div>') +
        panel("Raw Review", '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>');
    }

    function renderHypotheses(explanation) {
      const hypotheses = (explanation && explanation.hypotheses) || [];
      if (hypotheses.length === 0) {
        return '<div class="muted">No hypotheses available.</div>';
      }
      return hypotheses.map((item) =>
        '<div><strong>' + escapeHtml(item.label) + '</strong> ' + chip(item.status) +
        '<div class="meta">supporting: ' + escapeHtml((item.supporting_evidence_ids || []).join(", ")) + '</div></div>'
      ).join("");
    }

    function renderEvidence(item) {
      return '<div class="field"><span class="label">' + escapeHtml(item.evidenceId || item.evidence_id) + '</span>' +
        '<div class="value">' + escapeHtml(item.summary) + '</div>' +
        '<div class="meta">' + escapeHtml(item.source) + ' / ' + escapeHtml(item.sourceTier || item.source_tier) + '</div></div>';
    }

    function field(label, value) {
      return '<div class="field"><span class="label">' + escapeHtml(label) + '</span><div class="value">' + escapeHtml(value) + '</div></div>';
    }

    function panel(title, body) {
      return '<div class="panel"><div class="panel-title">' + escapeHtml(title) + '</div><div class="panel-body">' + body + '</div></div>';
    }

    function chip(value) {
      const text = String(value ?? "not_available");
      const className = text.replace(/[^a-zA-Z0-9_-]/g, "_");
      return '<span class="chip ' + escapeHtml(className) + '">' + escapeHtml(text) + '</span>';
    }

    function list(title, items) {
      if (!Array.isArray(items) || items.length === 0) {
        return "";
      }
      return '<div class="field"><span class="label">' + escapeHtml(title) + '</span><ul class="list">' +
        items.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul></div>';
    }

    if (tokenInput.value) {
      loadRuns();
    }
  </script>
</body>
</html>`;
}

import type { OperatorMode } from "./config";

export function runReviewConsoleHtml(options: { mode: OperatorMode }): string {
  const mode = options.mode;
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
    [hidden] { display: none !important; }
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
    .title {
      display: grid;
      gap: 8px;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid #475467;
      border-radius: 999px;
      padding: 3px 9px;
      color: #e4e7ec;
      font-size: 12px;
      font-weight: 760;
      white-space: nowrap;
    }
    .badge.mode-local {
      border-color: #84caff;
      background: #1849a9;
      color: #eff8ff;
    }
    .badge.mode-read_only {
      border-color: #fdb022;
      background: #93370d;
      color: #fff7ed;
    }
    .badge.simulation {
      border-color: #c7b9f6;
      background: #42307d;
      color: #f4f3ff;
    }
    .token {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: min(520px, 100%);
    }
    .actions {
      display: grid;
      gap: 8px;
      min-width: min(640px, 100%);
    }
    .demo {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    input, select {
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
    button.danger { background: var(--red); color: #ffffff; }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
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
    .status {
      color: #d0d5dd;
      font-size: 12px;
      text-align: right;
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
    .approval-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .timeline {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .timeline-item {
      border-left: 3px solid #c6d3e1;
      padding-left: 10px;
    }
    .timeline-item.success { border-left-color: var(--green); }
    .timeline-item.warning { border-left-color: var(--amber); }
    .timeline-item.material { border-left-color: var(--blue); }
    .timeline-item.suppressed { border-left-color: var(--slate); }
    .timeline-title {
      font-weight: 800;
      font-size: 13px;
      color: var(--text);
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
    .chip.pending_human_approval { background: #fff7ed; color: var(--amber); }
    .chip.human_approved { background: #ecfdf3; color: var(--green); }
    .chip.human_rejected { background: #fef3f2; color: var(--red); }
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
    .panel.approval-panel.pending_human_approval { border-color: #fedf89; }
    .panel.approval-panel.human_approved { border-color: #abefc6; }
    .panel.approval-panel.human_rejected { border-color: #fecdca; }
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
    .empty-state {
      display: grid;
      gap: 7px;
    }
    .empty-state strong {
      color: var(--ink);
      font-size: 15px;
    }
    .empty-state p {
      margin: 0;
      line-height: 1.45;
    }
    .notice {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 11px;
      font-weight: 700;
      line-height: 1.4;
    }
    .notice.info {
      background: #eef6ff;
      border-color: #b2ddff;
      color: var(--blue);
    }
    .notice.success {
      background: #ecfdf3;
      border-color: #abefc6;
      color: var(--green);
    }
    .notice.error {
      background: #fef3f2;
      border-color: #fecdca;
      color: var(--red);
    }
    .error {
      color: var(--red);
      font-weight: 700;
    }
    .run-link {
      border: 0;
      background: transparent;
      color: var(--blue);
      padding: 0;
      font-weight: 760;
      white-space: normal;
      text-align: left;
      overflow-wrap: anywhere;
    }
    .decision-heading {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .decision-mark {
      width: 22px;
      height: 22px;
      border: 1px solid var(--line);
      border-radius: 50%;
      display: inline-grid;
      place-items: center;
      flex: 0 0 22px;
      font-weight: 800;
    }
    @media (max-width: 900px) {
      .topbar { flex-direction: column; align-items: flex-start; }
      .actions, .demo, .token { width: 100%; }
      .demo, .token { flex-wrap: wrap; justify-content: flex-start; }
      .demo select, .token input { flex: 1 1 220px; }
      main { grid-template-columns: 1fr; padding: 14px; }
      .grid { grid-template-columns: 1fr; }
      .queue { max-height: none; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div class="title">
        <h1>Operator Run Review</h1>
        <div class="badges" aria-label="Runtime indicators">
          <span class="badge mode-${escapeAttribute(mode)}">Mode: ${escapeHtml(mode)}</span>
          <span class="badge simulation">Simulation only</span>
        </div>
      </div>
      <div class="actions">
        <div class="demo" id="demoControls" hidden>
          <select id="demoScenario" aria-label="Demo scenario"></select>
          <button id="runDemo" class="primary" type="button">Run Scenario</button>
        </div>
        <div class="token">
          <input id="token" type="password" autocomplete="off" placeholder="OPERATOR_READ_TOKEN">
          <input id="writeToken" type="password" autocomplete="off" placeholder="OPERATOR_WRITE_TOKEN">
          <button id="save" class="primary" type="button">Load</button>
          <button id="clear" class="secondary" type="button">Clear</button>
        </div>
        <div class="status" id="demoStatus"></div>
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
      <div id="detail" class="detail"><div class="empty">Run a scenario or select an existing run to review the decision and approval gate.</div></div>
    </section>
  </main>
  <script>
    const SERVER_MODE = ${JSON.stringify(mode)};
    const tokenInput = document.getElementById("token");
    const writeTokenInput = document.getElementById("writeToken");
    const demoControls = document.getElementById("demoControls");
    const demoScenario = document.getElementById("demoScenario");
    const demoStatus = document.getElementById("demoStatus");
    const runDemoButton = document.getElementById("runDemo");
    const runsEl = document.getElementById("runs");
    const detailEl = document.getElementById("detail");
    const summaryEl = document.getElementById("summary");
    let runs = [];
    let selectedRunId = "";
    let approvalFeedback = null;

    tokenInput.value = sessionStorage.getItem("operatorReadToken") || "";
    writeTokenInput.value = sessionStorage.getItem("operatorWriteToken") || "";
    document.getElementById("save").addEventListener("click", () => {
      sessionStorage.setItem("operatorReadToken", tokenInput.value);
      sessionStorage.setItem("operatorWriteToken", writeTokenInput.value);
      loadRuns();
    });
    document.getElementById("clear").addEventListener("click", () => {
      sessionStorage.removeItem("operatorReadToken");
      sessionStorage.removeItem("operatorWriteToken");
      tokenInput.value = "";
      writeTokenInput.value = "";
      runs = [];
      selectedRunId = "";
      approvalFeedback = null;
      renderRuns();
      renderReviewEmpty();
    });
    document.getElementById("refresh").addEventListener("click", loadRuns);
    runDemoButton.addEventListener("click", runDemoScenario);

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

    function writeHeaders(idempotencyKey) {
      const token = writeTokenInput.value || sessionStorage.getItem("operatorWriteToken") || "";
      return {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        ...(token ? { Authorization: "Bearer " + token } : {})
      };
    }

    async function loadRuns() {
      runsEl.innerHTML = '<div class="empty">Loading runs...</div>';
      const response = await fetch("/api/runs?limit=50", { headers: authHeaders() });
      if (!response.ok) {
        runsEl.innerHTML = '<div class="empty error">' + escapeHtml(runLoadError(response.status)) + '</div>';
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
      } else {
        renderReviewEmpty();
      }
    }

    function runLoadError(status) {
      if (status === 401) {
        return "Unable to load runs: 401. Enter OPERATOR_READ_TOKEN and click Load, or clear OPERATOR_READ_TOKEN for local demo mode.";
      }
      return "Unable to load runs: " + status;
    }

    async function loadDemoScenarios() {
      const response = await fetch("/api/demo/scenarios");
      if (!response.ok) {
        demoControls.hidden = true;
        return;
      }
      const data = await response.json();
      const scenarios = data.scenarios || [];
      if (scenarios.length === 0) {
        demoControls.hidden = true;
        return;
      }
      demoScenario.innerHTML = scenarios.map((scenario) =>
        '<option value="' + escapeHtml(scenario.id) + '">' + escapeHtml(scenario.label) + '</option>'
      ).join("");
      demoControls.hidden = false;
      if (!tokenInput.value) {
        await loadRuns();
      }
    }

    async function runDemoScenario() {
      const scenarioId = demoScenario.value;
      if (!scenarioId) {
        return;
      }
      demoStatus.textContent = "Running scenario...";
      runDemoButton.disabled = true;
      const response = await fetch("/api/demo/scenarios/" + encodeURIComponent(scenarioId), { method: "POST" });
      const data = await response.json().catch(() => ({}));
      runDemoButton.disabled = false;
      if (!response.ok) {
        demoStatus.textContent = "Scenario failed: " + (data.error || response.status);
        return;
      }
      selectedRunId = data.run_id || "";
      await loadRuns();
      demoStatus.textContent = "Scenario recorded.";
    }

    function renderRuns() {
      if (runs.length === 0) {
        runsEl.innerHTML = emptyRunsHtml();
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
          approvalFeedback = null;
          renderRuns();
          await loadReview(selectedRunId);
        });
      }
    }

    function emptyRunsHtml() {
      if (SERVER_MODE === "local") {
        return '<div class="empty empty-state">' +
          '<strong>No runs yet.</strong>' +
          '<p>Run a demo scenario above to create the first operator review.</p>' +
        '</div>';
      }
      return '<div class="empty empty-state">' +
        '<strong>No retained runs.</strong>' +
        '<p>Waiting for signed Grafana webhook runs. Enter the read token, then refresh after ingestion.</p>' +
      '</div>';
    }

    function renderReviewEmpty() {
      detailEl.innerHTML = '<div class="empty empty-state">' +
        '<strong>No run selected.</strong>' +
        '<p>Choose a retained run from the queue to inspect evidence, safety status, and approval gate state.</p>' +
      '</div>';
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
      const approval = data.approval || {};
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
        panel("Incident Lifecycle", renderLifecycle(data)) +
        panel("Evidence Re-entry", renderReentry(data)) +
        panel("RCA Hypothesis", renderHypotheses(review.explanation)) +
        panel("Decision", '<div class="chips">' + chip(decision.incident_class) + chip(decision.next_action) + chip("confidence " + (decision.confidence ?? "n/a")) + '</div>' + list("Verification", decision.verification_plan)) +
        panel("Mitigation", '<div class="chips">' + chip(mitigation.status) + chip(mitigation.approval_required ? "approval required" : "no approval") + '</div>' + field("Reason", mitigation.reason)) +
        panel("Approval Gate", renderApproval(approval), "approval-panel " + approvalPanelStatus(approval)) +
        panel("Evidence", evidence.slice(0, 8).map(renderEvidence).join("") || '<div class="muted">No evidence snapshot.</div>') +
        panel("Raw Review", '<pre>' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>');
      attachApprovalHandlers();
      attachLifecycleHandlers(run);
      attachRunLinkHandlers();
    }

    function renderLifecycle(data) {
      const lifecycle = data.lifecycle || {};
      const projection = lifecycle.projection || { state: "open" };
      const budgets = lifecycle.recoveryBudgets || [];
      const candidates = lifecycle.candidates || [];
      const latest = (lifecycle.verificationEvents || []).slice(-1)[0];
      return '<div class="chips">' + chip(projection.state) +
          chip((lifecycle.verificationEvents || []).length + " verification events") +
          chip(candidates.filter((item) => item.status === "pending").length + " pending reviews") +
        '</div>' +
        (latest ? field("Latest verification", latest.verification.outcome + " / " + latest.verification.sourceReference) : '<div class="muted">No independent verification has been recorded.</div>') +
        (budgets.length ? budgets.map((budget) => '<div class="field"><span class="label">' + escapeHtml(budget.failureClass) + '</span>' +
          '<div class="value">' + escapeHtml(budget.attempts + " of " + budget.limit + (budget.exhausted ? " / exhausted" : "")) + '</div>' +
          (budget.exhausted ? '<button class="secondary" type="button" data-reset-budget="' + escapeHtml(budget.failureClass) + '">Reset budget</button>' : '') +
        '</div>').join("") : '') +
        (candidates.length ? '<div class="timeline">' + candidates.map((candidate) =>
          '<div class="timeline-item warning"><div class="timeline-title">' + escapeHtml(candidate.category) + '</div>' +
          '<div class="meta">' + escapeHtml(candidate.status) + ' / ' + escapeHtml(candidate.candidateId) + '</div></div>'
        ).join("") + '</div>' : '') +
        '<div class="approval-actions">' +
          '<button class="secondary" type="button" data-verification="resolved">Resolved</button>' +
          '<button class="danger" type="button" data-verification="unresolved">Unresolved</button>' +
          '<button class="secondary" type="button" data-verification="inconclusive">Inconclusive</button>' +
          '<button class="secondary" type="button" data-feedback="corrected_finding">Correct finding</button>' +
          '<button class="secondary" type="button" data-feedback="reasoned_rejection">Reject recommendation</button>' +
        '</div>';
    }

    function attachLifecycleHandlers(run) {
      for (const button of detailEl.querySelectorAll("[data-verification]")) {
        button.addEventListener("click", async () => {
          const outcome = button.getAttribute("data-verification");
          const rationale = window.prompt("Verification rationale");
          if (!rationale) return;
          button.disabled = true;
          const response = await fetch(
            "/api/incidents/" + encodeURIComponent(run.incident_id) + "/verification",
            {
              method: "POST",
              headers: writeHeaders("ui:verification:" + run.run_id + ":" + outcome + ":" + Date.now()),
              body: JSON.stringify({
                outcome,
                run_id: run.run_id,
                evidence_ids: run.evidence_ids && run.evidence_ids.length ? [run.evidence_ids[0]] : ["operator:verification"],
                rationale
              })
            }
          );
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            button.disabled = false;
            window.alert("Verification failed: " + (error.error || response.status));
            return;
          }
          await loadReview(run.run_id);
        });
      }
      for (const button of detailEl.querySelectorAll("[data-feedback]")) {
        button.addEventListener("click", async () => {
          const category = button.getAttribute("data-feedback");
          const rationale = window.prompt("Review rationale");
          if (!rationale) return;
          const response = await fetch("/api/incidents/" + encodeURIComponent(run.incident_id) + "/feedback", {
            method: "POST",
            headers: writeHeaders("ui:feedback:" + run.run_id + ":" + category + ":" + Date.now()),
            body: JSON.stringify({
              category,
              run_id: run.run_id,
              evidence_ids: run.evidence_ids || [],
              rationale,
              snapshot: {}
            })
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            window.alert("Feedback failed: " + (error.error || response.status));
            return;
          }
          await loadReview(run.run_id);
        });
      }
      for (const button of detailEl.querySelectorAll("[data-reset-budget]")) {
        button.addEventListener("click", async () => {
          const failureClass = button.getAttribute("data-reset-budget");
          const rationale = window.prompt("Why is this budget safe to reset?");
          if (!rationale) return;
          const response = await fetch(
            "/api/incidents/" + encodeURIComponent(run.incident_id) + "/recovery/" + encodeURIComponent(failureClass) + "/reset",
            {
              method: "POST",
              headers: writeHeaders("ui:reset:" + run.run_id + ":" + failureClass + ":" + Date.now()),
              body: JSON.stringify({ run_id: run.run_id, reason: "operator_reset", rationale })
            }
          );
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            window.alert("Reset failed: " + (error.error || response.status));
            return;
          }
          await loadReview(run.run_id);
        });
      }
    }

    function renderReentry(data) {
      const run = data.run || {};
      const decision = data.gate_decision;
      if (!decision) {
        return '<div class="notice info">This retained run predates evidence re-entry tracking.</div>';
      }
      const parent = data.parent_run_id
        ? data.parent_run_retained
          ? '<button class="run-link" type="button" data-run-id="' + escapeHtml(data.parent_run_id) + '">' + escapeHtml(data.parent_run_id) + '</button>'
          : '<span class="muted">Parent run is no longer retained.</span>'
        : '<span class="muted">No parent. This run established the baseline.</span>';
      const history = (data.recent_gate_decisions || []).map(renderGateDecision).join("");
      return '<div class="grid">' +
          field("Trigger", gateDecisionLabel(decision)) +
          field("Basis", decision.basis) +
          htmlField("Parent run", parent) +
          field("Gate decision", decision.decision_id) +
        '</div>' +
        field("Rationale", decision.rationale) +
        '<div class="timeline" aria-label="Evidence re-entry history">' + history + '</div>';
    }

    function renderGateDecision(decision) {
      const fallback = decision.basis === "classifier_fallback";
      const tone = fallback ? "warning" : decision.outcome === "material" ? "material" : decision.outcome === "not_material" ? "suppressed" : "success";
      const mark = fallback ? "!" : decision.outcome === "material" ? "+" : decision.outcome === "not_material" ? "=" : "1";
      const child = decision.child_run_id
        ? ' / child: <button class="run-link" type="button" data-run-id="' + escapeHtml(decision.child_run_id) + '">' + escapeHtml(decision.child_run_id) + '</button>'
        : "";
      return '<div class="timeline-item ' + tone + '">' +
        '<div class="decision-heading"><span class="decision-mark" aria-hidden="true">' + mark + '</span><span class="timeline-title">' + escapeHtml(gateDecisionLabel(decision)) + '</span></div>' +
        '<div class="meta">' + escapeHtml(decision.created_at) + ' / basis: ' + escapeHtml(decision.basis) + child + '</div>' +
        '<div class="value">' + escapeHtml(decision.rationale) + '</div>' +
        '<div class="meta">' + escapeHtml(deltaSummary(decision.delta)) + '</div>' +
      '</div>';
    }

    function gateDecisionLabel(decision) {
      if (decision.basis === "classifier_fallback") {
        return "Classifier fallback: retriage";
      }
      if (decision.outcome === "first_observation") {
        return "First observation";
      }
      if (decision.outcome === "material") {
        return decision.basis === "classifier" ? "Classifier-confirmed material evidence" : "Material evidence";
      }
      return "Suppressed update";
    }

    function deltaSummary(delta) {
      const value = delta || {};
      return [
        (value.added || []).length + " added",
        (value.removed || []).length + " removed",
        (value.incidentChanges || []).length + " incident changes",
        (value.resolvedMissingContext || []).length + " missing-context gaps resolved"
      ].join(" / ");
    }

    function attachRunLinkHandlers() {
      for (const button of detailEl.querySelectorAll("[data-run-id]")) {
        button.addEventListener("click", async () => {
          selectedRunId = button.getAttribute("data-run-id") || "";
          renderRuns();
          await loadReview(selectedRunId);
        });
      }
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

    function renderApproval(approval) {
      const feedback = renderApprovalFeedback(approval);
      if (!approval.enabled) {
        return feedback +
          '<div class="notice info">Approval decisions are unavailable in this runtime mode.</div>' +
          (approval.approval_id ? field("Approval ID", approval.approval_id) : "");
      }
      if (!approval.approval_id) {
        return feedback + '<div class="muted">No approval is linked to this run.</div>';
      }
      const record = approval.record;
      if (!record) {
        return feedback + field("Approval ID", approval.approval_id) +
          '<div class="muted">No approval record has been staged for this run.</div>';
      }
      const disabled = record.status !== "pending_human_approval" ? " disabled" : "";
      const execution = record.execution
        ? field("Execution", record.execution.status + " / dry run: " + String(record.execution.dry_run))
        : "";
      return feedback +
        '<div class="notice info">Simulation only: approval decisions and executor results do not change production state.</div>' +
        '<div class="chips">' + chip(record.status) + chip(record.catalog_id) + chip(record.runbook_id) + '</div>' +
        '<div class="grid">' +
          field("Approval ID", record.approval_id) +
          field("Service", record.service) +
          field("Requested", record.requested_at) +
          field("Executed", String(record.executed)) +
        '</div>' +
        field("Action Intent", record.action_intent) +
        execution +
        renderApprovalTimeline(record) +
        '<div class="approval-actions">' +
          '<button class="primary" type="button" data-approval-decision="approve" data-approval-id="' + escapeHtml(record.approval_id) + '"' + disabled + '>Approve</button>' +
          '<button class="danger" type="button" data-approval-decision="reject" data-approval-id="' + escapeHtml(record.approval_id) + '"' + disabled + '>Reject</button>' +
        '</div>';
    }

    function approvalPanelStatus(approval) {
      const record = approval && approval.record;
      return record && record.status ? record.status : "not_available";
    }

    function renderApprovalFeedback(approval) {
      if (!approvalFeedback) {
        return "";
      }
      if (approvalFeedback.approvalId && approval.approval_id && approvalFeedback.approvalId !== approval.approval_id) {
        return "";
      }
      const role = approvalFeedback.kind === "error" ? "alert" : "status";
      return '<div class="notice ' + escapeHtml(approvalFeedback.kind) + '" role="' + role + '">' +
        escapeHtml(approvalFeedback.message) +
      '</div>';
    }

    function renderApprovalTimeline(record) {
      const decided = record.decided_at
        ? timelineItem("Decision recorded", record.decided_at + " / actor: local_operator / status: " + record.status, record.status === "human_approved" ? "success" : "warning")
        : timelineItem("Awaiting decision", "actor: local_operator / status: pending_human_approval", "warning");
      const execution = record.execution
        ? timelineItem("Simulated executor", record.execution.status + " / dry run: " + String(record.execution.dry_run) + " / executed: " + String(record.execution.executed))
        : "";
      return '<div class="timeline" aria-label="Approval audit timeline">' +
        timelineItem("Approval requested", record.requested_at + " / catalog: " + record.catalog_id) +
        decided +
        execution +
      '</div>';
    }

    function timelineItem(title, body, tone) {
      const toneClass = tone ? " " + tone : "";
      return '<div class="timeline-item' + toneClass + '"><div class="timeline-title">' + escapeHtml(title) + '</div><div class="meta">' + escapeHtml(body) + '</div></div>';
    }

    function attachApprovalHandlers() {
      for (const button of detailEl.querySelectorAll("[data-approval-decision]")) {
        button.addEventListener("click", async () => {
          const approvalId = button.getAttribute("data-approval-id") || "";
          const decision = button.getAttribute("data-approval-decision") || "";
          await decideApprovalAction(approvalId, decision);
        });
      }
    }

    async function decideApprovalAction(approvalId, decision) {
      if (!approvalId || !decision) {
        return;
      }
      approvalFeedback = { approvalId, kind: "info", message: decision === "approve" ? "Approving simulated mitigation..." : "Rejecting simulated mitigation..." };
      renderApprovalFeedbackInPlace();
      const response = await fetch("/api/approvals/" + encodeURIComponent(approvalId) + "/" + decision, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        approvalFeedback = { approvalId, kind: "error", message: "Approval decision failed: " + (body.error || response.status) };
        renderApprovalFeedbackInPlace();
        return;
      }
      approvalFeedback = { approvalId, kind: "success", message: "Approval decision recorded. Simulated executor state refreshed below." };
      if (selectedRunId) {
        await loadReview(selectedRunId);
      }
      demoStatus.textContent = "";
    }

    function renderApprovalFeedbackInPlace() {
      const panelBody = detailEl.querySelector(".approval-panel .panel-body");
      if (!panelBody || !approvalFeedback) {
        return;
      }
      let notice = panelBody.querySelector("[data-approval-feedback]");
      if (!notice) {
        notice = document.createElement("div");
        notice.setAttribute("data-approval-feedback", "true");
        panelBody.prepend(notice);
      }
      notice.className = "notice " + approvalFeedback.kind;
      notice.setAttribute("role", approvalFeedback.kind === "error" ? "alert" : "status");
      notice.textContent = approvalFeedback.message;
    }

    function field(label, value) {
      return '<div class="field"><span class="label">' + escapeHtml(label) + '</span><div class="value">' + escapeHtml(value) + '</div></div>';
    }

    function htmlField(label, value) {
      return '<div class="field"><span class="label">' + escapeHtml(label) + '</span><div class="value">' + value + '</div></div>';
    }

    function panel(title, body, className) {
      const extraClass = className ? " " + escapeHtml(className) : "";
      return '<div class="panel' + extraClass + '"><div class="panel-title">' + escapeHtml(title) + '</div><div class="panel-body">' + body + '</div></div>';
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

    loadDemoScenarios();
    if (tokenInput.value) {
      loadRuns();
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

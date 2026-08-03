export function approvalConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Incident Approval Console</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --panel: #ffffff;
      --ink: #172033;
      --muted: #647086;
      --line: #d9dee8;
      --teal: #0f766e;
      --amber: #b45309;
      --red: #b42318;
      --green: #15803d;
      --blue: #1d4ed8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: #101828;
      color: #f8fafc;
    }
    .topbar {
      max-width: 1180px;
      margin: 0 auto;
      padding: 18px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 720;
      letter-spacing: 0;
    }
    .banner {
      border: 1px solid #f7d394;
      background: #fff7ed;
      color: #7c2d12;
      padding: 9px 12px;
      border-radius: 6px;
      font-weight: 650;
      white-space: nowrap;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 22px 24px 36px;
      display: grid;
      grid-template-columns: minmax(320px, 0.95fr) minmax(360px, 1.25fr);
      gap: 18px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-width: 0;
    }
    .section-head {
      min-height: 58px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    h2 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0;
    }
    .count {
      color: var(--muted);
      font-size: 13px;
    }
    .queue {
      display: grid;
      gap: 0;
    }
    .row {
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: transparent;
      padding: 14px 16px;
      text-align: left;
      cursor: pointer;
      display: grid;
      gap: 8px;
      color: inherit;
      font: inherit;
    }
    .row:hover, .row.active { background: #eef6ff; }
    .row:last-child { border-bottom: 0; }
    .row-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      font-weight: 700;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .status {
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      font-weight: 750;
      white-space: nowrap;
    }
    .pending_human_approval { background: #fff7ed; color: var(--amber); }
    .human_approved { background: #ecfdf3; color: var(--green); }
    .human_rejected { background: #fef3f2; color: var(--red); }
    .detail {
      padding: 16px;
      display: grid;
      gap: 16px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .field {
      border-bottom: 1px solid var(--line);
      padding-bottom: 10px;
      min-width: 0;
    }
    .label {
      color: var(--muted);
      display: block;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 5px;
      text-transform: uppercase;
    }
    .value {
      overflow-wrap: anywhere;
      line-height: 1.35;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button.action {
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 10px 12px;
      color: #ffffff;
      font-weight: 750;
      cursor: pointer;
    }
    button.action:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .approve { background: var(--teal); }
    .reject { background: var(--red); }
    .refresh { background: var(--blue); }
    pre {
      margin: 0;
      padding: 12px;
      border-radius: 6px;
      background: #111827;
      color: #d1fae5;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.45;
    }
    .empty {
      padding: 28px 16px;
      color: var(--muted);
    }
    @media (max-width: 820px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .banner { white-space: normal; }
      main { grid-template-columns: 1fr; padding: 16px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <h1>Incident Approval Console</h1>
      <div class="banner">Simulation only: approvals never execute production actions</div>
    </div>
  </header>
  <main>
    <section>
      <div class="section-head">
        <h2>Approval Queue</h2>
        <button class="action refresh" type="button" id="refresh">Refresh</button>
      </div>
      <div id="queue" class="queue"><div class="empty">Loading approvals...</div></div>
    </section>
    <section>
      <div class="section-head">
        <h2>Approval Detail</h2>
        <span class="count" id="summary"></span>
      </div>
      <div id="detail" class="detail"><div class="empty">Select an approval to review.</div></div>
    </section>
  </main>
  <script>
    let approvals = [];
    let selectedId = "";

    const queue = document.getElementById("queue");
    const detail = document.getElementById("detail");
    const summary = document.getElementById("summary");
    document.getElementById("refresh").addEventListener("click", loadApprovals);

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    async function loadApprovals() {
      const response = await fetch("/api/approvals");
      const data = await response.json();
      approvals = data.approvals ?? [];
      summary.textContent = data.summary ? data.summary.pending + " pending / " + data.summary.total + " total" : "";
      if (!selectedId && approvals.length > 0) {
        selectedId = approvals[0].approval_id;
      }
      renderQueue();
      renderDetail();
    }

    function renderQueue() {
      if (approvals.length === 0) {
        queue.innerHTML = '<div class="empty">No approval records yet.</div>';
        return;
      }
      queue.innerHTML = approvals.map((approval) => {
        const active = approval.approval_id === selectedId ? " active" : "";
        return '<button class="row' + active + '" type="button" data-id="' + escapeHtml(approval.approval_id) + '">' +
          '<div class="row-title"><span>' + escapeHtml(approval.service) + '</span><span class="status ' + escapeHtml(approval.status) + '">' + escapeHtml(approval.status) + '</span></div>' +
          '<div class="meta">' + escapeHtml(approval.incident_id) + ' / ' + escapeHtml(approval.runbook_id) + '</div>' +
          '<div class="meta">' + escapeHtml(approval.action_intent) + '</div>' +
        '</button>';
      }).join("");
      for (const row of queue.querySelectorAll(".row")) {
        row.addEventListener("click", () => {
          selectedId = row.getAttribute("data-id") ?? "";
          renderQueue();
          renderDetail();
        });
      }
    }

    function renderDetail() {
      const approval = approvals.find((item) => item.approval_id === selectedId);
      if (!approval) {
        detail.innerHTML = '<div class="empty">Select an approval to review.</div>';
        return;
      }
      const disabled = approval.status !== "pending_human_approval" ? " disabled" : "";
      detail.innerHTML =
        '<div class="grid">' +
          field("Approval ID", approval.approval_id) +
          field("Status", approval.status) +
          field("Incident", approval.incident_id) +
          field("Service", approval.service) +
          field("Catalog", approval.catalog_id) +
          field("Runbook", approval.runbook_id) +
          field("Requested", approval.requested_at) +
          field("Executed", String(approval.executed)) +
        '</div>' +
        '<div class="field"><span class="label">Action Intent</span><div class="value">' + escapeHtml(approval.action_intent) + '</div></div>' +
        '<div class="actions">' +
          '<button class="action approve" type="button" id="approve"' + disabled + '>Approve</button>' +
          '<button class="action reject" type="button" id="reject"' + disabled + '>Reject</button>' +
        '</div>' +
        '<pre>' + escapeHtml(JSON.stringify(approval, null, 2)) + '</pre>';
      document.getElementById("approve").addEventListener("click", () => decide("approve"));
      document.getElementById("reject").addEventListener("click", () => decide("reject"));
    }

    function field(label, value) {
      return '<div class="field"><span class="label">' + escapeHtml(label) + '</span><div class="value">' + escapeHtml(value) + '</div></div>';
    }

    async function decide(decision) {
      await fetch("/api/approvals/" + encodeURIComponent(selectedId) + "/" + decision, { method: "POST" });
      await loadApprovals();
    }

    loadApprovals().catch((error) => {
      queue.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>';
    });
  </script>
</body>
</html>`;
}

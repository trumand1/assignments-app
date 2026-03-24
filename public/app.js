const MODES = {
  LOCAL: "local",
  HOSTED: "hosted",
};

const PANEL_META = {
  creds: "Credentials",
  upload: "Upload",
  preview: "Review",
  result: "Done",
};

const STATUS_IDS = ["credsStatus", "uploadStatus", "previewStatus"];
const PROXY_ORIGIN = "http://localhost:8787";
const LOCAL_PROXY_BASE = `${PROXY_ORIGIN}/api`;
const HOSTED_API_BASE = "/api";
const LOCAL_CRED_IDS = ["jiraEmail", "jiraToken", "jiraDomain", "jiraProject", "anthropicKey"];

let appMode = MODES.LOCAL;
let assignments = [];
let imageBase64 = null;
let currentPanel = "creds";
let isParsing = false;
let isSending = false;
let lastResults = null;

window.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  setupDragDrop();
  setupPreviewInteractions();
  loadCreds();
  await initializeMode();
});

async function initializeMode() {
  const config = await detectMode();
  appMode = config.mode === MODES.HOSTED ? MODES.HOSTED : MODES.LOCAL;
  applyMode();
  updateCredBadge();
  refreshActionStates();

  const initialPanel = appMode === MODES.HOSTED
    ? "upload"
    : (hasLocalCreds() ? "upload" : "creds");

  showPanel(initialPanel);

  if (appMode === MODES.LOCAL && location.protocol === "file:") {
    showStatus("credsStatus", "info", "Serve this folder with `python3 -m http.server 8080` and open `http://localhost:8080` for the local proxy flow.");
  }
}

async function detectMode() {
  try {
    const res = await fetch(`${HOSTED_API_BASE}/config`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { mode: MODES.LOCAL };
    const data = await res.json();
    if (data?.mode === MODES.HOSTED) return data;
  } catch (_err) {
    return { mode: MODES.LOCAL };
  }
  return { mode: MODES.LOCAL };
}

function applyMode() {
  document.querySelectorAll(".local-only").forEach((el) => {
    el.classList.toggle("is-hidden", appMode !== MODES.LOCAL);
  });

  const uploadSubtitle = document.getElementById("uploadSubtitle");
  if (appMode === MODES.HOSTED) {
    uploadSubtitle.textContent = "Take a screenshot of your Canvas or LearningSuite page and drop it below. The hosted app will parse assignments and create Jira tasks using your saved server-side settings.";
  } else {
    uploadSubtitle.textContent = "Take a screenshot of your Canvas or LearningSuite page and drop it below. Gemini will extract assignment names and due dates automatically.";
  }
}

function setupEventListeners() {
  document.getElementById("fileInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) processFile(file);
  });

  document.getElementById("headerSettingsBtn").addEventListener("click", () => showPanel("creds"));
  document.getElementById("uploadSettingsBtn").addEventListener("click", () => showPanel("creds"));
  document.getElementById("saveCredsBtn").addEventListener("click", saveCreds);
  document.getElementById("parseBtn").addEventListener("click", parseScreenshot);
  document.getElementById("sendBtn").addEventListener("click", sendToJira);
  document.getElementById("addRowBtn").addEventListener("click", addRow);
  document.getElementById("previewBackBtn").addEventListener("click", () => showPanel("upload"));
  document.getElementById("resetBtn").addEventListener("click", resetApp);
}

function setupPreviewInteractions() {
  const previewBody = document.getElementById("previewBody");

  previewBody.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const field = target.dataset.field;
    if (!field) return;
    const row = target.closest("tr");
    const idx = Number(row?.dataset.idx);
    if (Number.isNaN(idx) || !assignments[idx]) return;
    assignments[idx][field] = target.value;
  });

  previewBody.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains("row-toggle")) return;
    toggleRow(target);
  });

  previewBody.addEventListener("click", (event) => {
    const target = event.target;
    const button = target.closest("button[data-action='remove']");
    if (!(button instanceof HTMLButtonElement)) return;
    const row = button.closest("tr");
    const idx = Number(row?.dataset.idx);
    if (Number.isNaN(idx)) return;
    removeRow(idx);
  });
}

function getVisiblePanels() {
  return appMode === MODES.HOSTED
    ? ["upload", "preview", "result"]
    : ["creds", "upload", "preview", "result"];
}

function getPanelElement(name) {
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return document.getElementById(`panel${cap}`);
}

function isPanelUnlocked(name) {
  if (!getVisiblePanels().includes(name)) return false;

  switch (name) {
    case "creds":
      return appMode === MODES.LOCAL;
    case "upload":
      return appMode === MODES.HOSTED || hasLocalCreds();
    case "preview":
      return assignments.length > 0;
    case "result":
      return Boolean(lastResults);
    default:
      return false;
  }
}

function renderSteps() {
  const stepsNav = document.getElementById("stepsNav");
  const visiblePanels = getVisiblePanels();
  const currentIndex = visiblePanels.indexOf(currentPanel);

  stepsNav.innerHTML = visiblePanels.map((panel, index) => {
    const unlocked = isPanelUnlocked(panel);
    const active = panel === currentPanel;
    const done = currentIndex > index;
    const classes = [
      "step-item",
      active ? "active" : "",
      done ? "done" : "",
      unlocked ? "unlocked" : "locked",
    ].filter(Boolean).join(" ");

    const connector = index < visiblePanels.length - 1
      ? '<div class="step-connector" aria-hidden="true"></div>'
      : "";

    return `
      <div class="${classes}">
        <button class="step-button" type="button" data-step="${panel}" ${unlocked ? "" : "disabled"}>
          <span class="step-main">
            <span class="step-circle">${index + 1}</span>
            <span class="step-name">${PANEL_META[panel]}</span>
          </span>
        </button>
        ${connector}
      </div>
    `;
  }).join("");

  stepsNav.querySelectorAll(".step-button[data-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = button.dataset.step;
      if (panel) showPanel(panel);
    });
  });
}

function showPanel(name, options = {}) {
  if (!getVisiblePanels().includes(name)) return;
  if (!isPanelUnlocked(name)) return;

  currentPanel = name;
  clearStatusMessages(options.preserveStatusIds || []);

  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
  const nextPanel = getPanelElement(name);
  if (nextPanel) nextPanel.classList.add("active");

  renderSteps();
  refreshActionStates();
}

function clearStatusMessages(preserveIds = []) {
  document.querySelectorAll(".status-msg").forEach((el) => {
    if (preserveIds.includes(el.id)) return;
    el.className = "status-msg";
    el.textContent = "";
  });
}

function hasLocalCreds() {
  return LOCAL_CRED_IDS.every((id) => {
    const value = localStorage.getItem(id);
    return Boolean(value && value.trim());
  });
}

function loadCreds() {
  LOCAL_CRED_IDS.forEach((id) => {
    const value = localStorage.getItem(id);
    const input = document.getElementById(id);
    if (value && input) input.value = value;
  });
}

function saveCreds() {
  if (appMode !== MODES.LOCAL) return;

  clearStatusMessages(["credsStatus"]);

  for (const id of LOCAL_CRED_IDS) {
    const input = document.getElementById(id);
    const value = input.value.trim();
    if (!value) {
      showStatus("credsStatus", "error", "Please fill in all fields.");
      return;
    }
    localStorage.setItem(id, value);
  }

  const domain = normalizeDomain(localStorage.getItem("jiraDomain"));
  localStorage.setItem("jiraDomain", domain);
  document.getElementById("jiraDomain").value = domain;

  const project = (localStorage.getItem("jiraProject") || "").toUpperCase();
  localStorage.setItem("jiraProject", project);
  document.getElementById("jiraProject").value = project;

  updateCredBadge();
  renderSteps();
  showStatus("credsStatus", "success", "Saved! Heading to upload…");
  setTimeout(() => showPanel("upload"), 700);
}

function updateCredBadge() {
  const dot = document.getElementById("credDot");
  const label = document.getElementById("credLabel");

  if (appMode === MODES.HOSTED) {
    dot.classList.add("ok");
    label.textContent = "Hosted mode";
    return;
  }

  const ok = hasLocalCreds();
  dot.classList.toggle("ok", ok);
  label.textContent = ok ? (localStorage.getItem("jiraDomain") || "Configured") : "No credentials";
}

function normalizeDomain(value) {
  return String(value || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function getLocalJiraCreds() {
  return {
    email: localStorage.getItem("jiraEmail"),
    token: localStorage.getItem("jiraToken"),
    domain: normalizeDomain(localStorage.getItem("jiraDomain")),
    project: (localStorage.getItem("jiraProject") || "").toUpperCase(),
  };
}

function formatApiError(status, data) {
  const fallback = `Request failed (${status})`;
  const base =
    data.error ||
    (Array.isArray(data.errorMessages) && data.errorMessages[0]) ||
    (data.errors && Object.values(data.errors).join(", ")) ||
    data.detail ||
    data.title ||
    fallback;

  if (status === 401) {
    return `Authentication failed. Check your Jira email/API token in local mode, or your Worker secrets in hosted mode. ${base !== fallback ? `(${base})` : ""}`.trim();
  }
  if (status === 403) {
    return `The request was authenticated but not allowed. Check Jira project permissions. ${base !== fallback ? `(${base})` : ""}`.trim();
  }
  return base;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    throw new Error(formatApiError(res.status, data));
  }

  return data;
}

async function localProxyRequest(path, payload) {
  try {
    return await postJson(`${LOCAL_PROXY_BASE}${path}`, payload);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`Could not reach the local Jira proxy at ${PROXY_ORIGIN}. Start jira_proxy.py and reload.`);
    }
    throw err;
  }
}

async function hostedRequest(path, payload) {
  return postJson(`${HOSTED_API_BASE}${path}`, payload);
}

function setupDragDrop() {
  const area = document.getElementById("uploadArea");
  area.addEventListener("dragover", (event) => {
    event.preventDefault();
    area.classList.add("dragover");
  });
  area.addEventListener("dragleave", () => area.classList.remove("dragover"));
  area.addEventListener("drop", (event) => {
    event.preventDefault();
    area.classList.remove("dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file && file.type.startsWith("image/")) processFile(file);
  });
}

function processFile(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const url = event.target?.result;
    if (typeof url !== "string") return;
    imageBase64 = url.split(",")[1];
    document.getElementById("previewImg").src = url;
    document.getElementById("uploadPreview").style.display = "block";
    refreshActionStates();
    clearStatusMessages();
    showStatus("uploadStatus", "info", `Loaded: ${file.name}. Add a course label below, then click Extract Assignments.`);
  };
  reader.readAsDataURL(file);
}

async function parseScreenshot() {
  if (!imageBase64 || isParsing) return;

  const label = document.getElementById("classLabel").value.trim() || "UNCATEGORIZED";
  clearStatusMessages();
  isParsing = true;
  refreshActionStates();
  setLoading(true, "Analyzing screenshot with Gemini…");

  try {
    let parsedAssignments = [];

    if (appMode === MODES.HOSTED) {
      const data = await hostedRequest("/parse", { imageBase64, label });
      parsedAssignments = data.assignments || [];
    } else {
      const key = localStorage.getItem("anthropicKey");
      if (!key) {
        throw new Error("Missing Gemini API key — go to Settings.");
      }

      const prompt = `Extract all assignments from this course management screenshot (Canvas or BYU LearningSuite).

Return ONLY a valid JSON array — no markdown, no backticks, no explanation. Each object must have:
- "name": assignment name (string)
- "dueDate": due date as YYYY-MM-DD using year 2026. If only month/day shown (e.g. "Mar 20"), use 2026. If no date, use null.
- "label": "${label}"

Include all items: homework, labs, quizzes, readings, lectures. Skip section headers like "Unit 4: Strings".

Example: [{"name":"Lab 4a - Strings","dueDate":"2026-03-10","label":"${label}"}]`;

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: "image/png", data: imageBase64 } },
              { text: prompt },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1500 },
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `API error ${res.status}`);

      const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
      parsedAssignments = JSON.parse(text.replace(/```json|```/g, "").trim());
    }

    assignments = normalizeAssignments(parsedAssignments, label);
    if (!assignments.length) throw new Error("No assignments found in screenshot.");

    setLoading(true, "Checking for duplicates in Jira…");
    const existing = await fetchExistingTasks();
    assignments = assignments.map((assignment) => ({
      ...assignment,
      dupMatch: findDuplicate(assignment.name, existing),
    }));

    buildTable(assignments);
    updateCount();
    setLoading(false);

    const preserveStatusIds = document.getElementById("previewStatus").classList.contains("show")
      ? ["previewStatus"]
      : [];
    showPanel("preview", { preserveStatusIds });
  } catch (err) {
    setLoading(false);
    showStatus("uploadStatus", "error", `Error: ${err.message}`);
  } finally {
    isParsing = false;
    refreshActionStates();
  }
}

function normalizeAssignments(items, label) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      name: String(item?.name || "").trim(),
      dueDate: item?.dueDate || "",
      label: String(item?.label || label || "").trim(),
      dupMatch: null,
    }))
    .filter((item) => item.name);
}

function buildTable(items) {
  const tbody = document.getElementById("previewBody");
  tbody.innerHTML = "";

  items.forEach((item, index) => {
    const tr = document.createElement("tr");
    tr.dataset.idx = String(index);
    if (item.dupMatch) tr.classList.add("maybe-dup");

    const dupHtml = item.dupMatch
      ? `<span class="dup-badge" title="Possible duplicate of: ${esc(item.dupMatch)}">
           <svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
           possible dup
         </span>`
      : "";

    tr.innerHTML = `
      <td><input type="checkbox" class="row-toggle" checked aria-label="Include row"></td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <input class="editable-cell assignment-name" data-field="name" value="${esc(item.name)}" placeholder="New Assignment" style="flex:1;min-width:120px">
          ${dupHtml}
        </div>
      </td>
      <td><input class="editable-cell date-input" data-field="dueDate" type="date" value="${item.dueDate || ""}"></td>
      <td><input class="label-input" data-field="label" value="${esc(item.label || "")}" placeholder="Course label"></td>
      <td>
        <button class="btn btn-danger" type="button" data-action="remove" title="Remove">
          <svg viewBox="0 0 24 24" style="width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

function toggleRow(checkbox) {
  checkbox.closest("tr")?.classList.toggle("excluded", !checkbox.checked);
  updateCount();
}

function removeRow(index) {
  assignments.splice(index, 1);
  buildTable(assignments);
  updateCount();
}

function addRow() {
  if (isSending) return;
  const label = document.getElementById("classLabel").value.trim() || "";
  assignments.push({ name: "", dueDate: "", label, dupMatch: null });
  buildTable(assignments);
  updateCount();
  const rows = document.querySelectorAll("#previewBody tr");
  rows[rows.length - 1]?.querySelector(".assignment-name")?.focus();
}

function updateCount() {
  const selectedCount = document.querySelectorAll("#previewBody tr:not(.excluded)").length;
  document.getElementById("previewCount").textContent = `${selectedCount} task${selectedCount !== 1 ? "s" : ""}`;

  const duplicateCount = document.querySelectorAll("#previewBody tr.maybe-dup:not(.excluded)").length;
  const duplicateEl = document.getElementById("dupCount");
  duplicateEl.style.display = duplicateCount ? "inline-flex" : "none";
  duplicateEl.textContent = `${duplicateCount} possible duplicate${duplicateCount !== 1 ? "s" : ""}`;

  refreshActionStates();
}

async function fetchExistingTasks() {
  const names = [];
  const maxResults = 100;
  let nextPageToken = null;

  try {
    while (true) {
      let response;

      if (appMode === MODES.HOSTED) {
        const payload = { maxResults };
        if (nextPageToken) payload.nextPageToken = nextPageToken;
        response = await hostedRequest("/jira/search", payload);
      } else {
        const { email, token, domain, project } = getLocalJiraCreds();
        if (!email || !token || !domain || !project) return [];
        const payload = { email, token, domain, project, maxResults };
        if (nextPageToken) payload.nextPageToken = nextPageToken;
        response = await localProxyRequest("/jira/search", payload);
      }

      const issues = response.issues || [];
      issues.forEach((issue) => {
        if (issue?.fields?.summary) names.push(issue.fields.summary);
      });

      nextPageToken = response.nextPageToken || null;
      if (!nextPageToken || !issues.length) break;
    }
  } catch (err) {
    showStatus("previewStatus", "info", `Duplicate check unavailable: ${err.message}`);
    console.warn("Could not fetch existing Jira tasks for duplicate check:", err);
  }

  return names;
}

function levenshtein(a, b) {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  const m = left.length;
  const n = right.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : (j === 0 ? i : 0))));

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = left[i - 1] === right[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

function findDuplicate(name, existingNames) {
  let best = null;
  let bestDistance = Infinity;

  for (const existingName of existingNames) {
    const distance = levenshtein(name, existingName);
    const threshold = Math.max(3, Math.floor(Math.max(name.length, existingName.length) * 0.15));
    if (distance <= threshold && distance < bestDistance) {
      bestDistance = distance;
      best = existingName;
    }
  }

  return best;
}

async function sendToJira() {
  if (isSending) return;

  if (appMode === MODES.LOCAL) {
    const { email, token, domain, project } = getLocalJiraCreds();
    if (!email || !token || !domain || !project) {
      showStatus("previewStatus", "error", "Missing Jira credentials — go to Settings.");
      return;
    }
  }

  const selectedRows = [...document.querySelectorAll("#previewBody tr:not(.excluded)")];
  const toSend = selectedRows.map((row) => assignments[Number(row.dataset.idx)]).filter(Boolean);
  if (!toSend.length) {
    showStatus("previewStatus", "error", "No tasks selected.");
    return;
  }

  clearStatusMessages();
  isSending = true;
  refreshActionStates();
  setLoading(true, `Creating ${toSend.length} task${toSend.length !== 1 ? "s" : ""} in Jira…`);

  const skipped = assignments.length - toSend.length;
  const results = [];

  try {
    for (const item of toSend) {
      try {
        const response = await createIssue(item);
        if (response.key) {
          results.push({ name: item.name, status: "ok", key: response.key });
        } else {
          const message = response.errors
            ? Object.values(response.errors).join(", ")
            : (response.errorMessages?.[0] || "Unknown Jira error");
          results.push({ name: item.name, status: "fail", error: message });
        }
      } catch (err) {
        results.push({ name: item.name, status: "fail", error: err.message });
      }
    }
  } finally {
    isSending = false;
    setLoading(false);
    refreshActionStates();
  }

  showResults(results, skipped);
}

async function createIssue(item) {
  if (appMode === MODES.HOSTED) {
    return hostedRequest("/jira/issue", {
      summary: item.name,
      dueDate: item.dueDate || null,
      label: item.label || "",
    });
  }

  const { email, token, domain, project } = getLocalJiraCreds();
  const fields = {
    project: { key: project },
    summary: item.name,
    issuetype: { name: "Task" },
    labels: item.label ? [normalizeLabel(item.label)] : [],
  };

  if (item.dueDate) fields.duedate = item.dueDate;

  return localProxyRequest("/jira/issue", { email, token, domain, fields });
}

function normalizeLabel(label) {
  return String(label || "").trim().replace(/\s+/g, "_");
}

function showResults(results, skipped) {
  lastResults = { results, skipped };
  const created = results.filter((result) => result.status === "ok").length;
  const failed = results.filter((result) => result.status === "fail").length;

  document.getElementById("resultCreated").textContent = String(created);
  document.getElementById("resultFailed").textContent = String(failed);
  document.getElementById("resultSkipped").textContent = String(skipped);
  document.getElementById("resultList").innerHTML = results.map((result) => `
    <div class="result-item">
      <div class="result-dot ${result.status}"></div>
      <div class="result-item-name">${esc(result.name)}</div>
      <div class="result-item-status">${result.status === "ok" ? esc(result.key) : `✗ ${esc(result.error)}`}</div>
    </div>
  `).join("");

  showPanel("result");
}

function resetApp() {
  assignments = [];
  imageBase64 = null;
  lastResults = null;
  document.getElementById("fileInput").value = "";
  document.getElementById("uploadPreview").style.display = "none";
  document.getElementById("previewImg").src = "";
  document.getElementById("previewBody").innerHTML = "";
  document.getElementById("resultList").innerHTML = "";
  clearStatusMessages();
  updateCount();

  const nextPanel = appMode === MODES.HOSTED
    ? "upload"
    : (hasLocalCreds() ? "upload" : "creds");
  showPanel(nextPanel);
}

function setLoading(show, text) {
  document.getElementById("loadingOverlay").classList.toggle("show", show);
  if (text) {
    document.getElementById("loadingText").textContent = text;
  }
}

function showStatus(id, type, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `status-msg ${type} show`;
  el.textContent = message;
}

function refreshActionStates() {
  const parseButton = document.getElementById("parseBtn");
  const sendButton = document.getElementById("sendBtn");
  const addRowButton = document.getElementById("addRowBtn");
  const previewBackButton = document.getElementById("previewBackBtn");

  parseButton.disabled = !imageBase64 || isParsing;
  sendButton.disabled = isSending || document.querySelectorAll("#previewBody tr:not(.excluded)").length === 0;
  addRowButton.disabled = isSending;
  previewBackButton.disabled = isSending;
}

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

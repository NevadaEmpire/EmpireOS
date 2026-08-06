import { Inviter, Registerer, SessionState, UserAgent } from "sip.js";

const state = {
  user: null,
  viewMode: "advisor",
  phone: null,
  userAgent: null,
  registerer: null,
  session: null,
  queueMembers: [],
  callStartedAt: null,
  callTimer: null,
  layout: null,
  customerFieldOptions: [],
  campaigns: [],
  currentLead: null,
  currentScript: "",
  powerDial: false,
  powerBatch: null,
  powerDialTimer: null,
  powerDialStarting: false,
  messageWith: null,
  messageTimer: null,
  messageUnreadTotal: 0,
  messageCanBroadcast: false,
  csvHeaders: [],
  csvSample: [],
  csvRows: [],
  customCallFields: [],
  pendingLeadImport: null,
  adminUsers: [],
  notesTimer: null,
  advisorWaitTimer: null,
  advisorWaitRefreshTimer: null,
  masonConfigured: false,
  masonTranscript: [],
  masonCapture: null,
  savedLeadFilters: [],
  leadAdmin: { page: 1, pages: 1, selected: new Set(), rows: [], facets: null },
  performance: { dials: 0, connections: 0, talkSeconds: 0, commissions: { today: 0, week: 0, all: 0 } },
};

const $ = (selector) => document.querySelector(selector);
const loginView = $("#login-view");
const appView = $("#app-view");
const statusNode = $("#phone-status");
const errorNode = $("#error-message");
const remoteAudio = $("#remote-audio");

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function setError(message = "") {
  errorNode.textContent = message;
  errorNode.hidden = !message;
}

function setPhoneStatus(label, tone = "offline") {
  statusNode.textContent = label;
  statusNode.dataset.tone = tone;
  const screen = $("#phone-screen-status");
  if (screen) screen.textContent = tone === "active" ? "CONNECTED" : tone === "ringing" ? "INCOMING" : tone === "pending" ? "CONNECTING" : tone === "online" ? "READY" : "OFFLINE";
}

function recordActivity(type, details = {}) {
  return api("/api/activity", { method: "POST", body: JSON.stringify({ type, ...details }) }).catch(() => {});
}

const on = (selector, eventName, handler) => {
  const node = $(selector);
  if (node) node.addEventListener(eventName, handler);
};

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDialNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : value || "—";
}

function terminalElapsed(line) {
  const terminalStatuses = ["failed", "machine", "no-answer", "cancelled", "connected", "stopped", "complete"];
  const start = new Date(line?.startedAt || 0).getTime();
  const frozenAt = line?.endedAt || (terminalStatuses.includes(line?.status) ? line?.updatedAt : null);
  const end = frozenAt ? new Date(frozenAt).getTime() : Date.now();
  return Number.isFinite(start) && start > 0 && Number.isFinite(end) ? formatDuration(Math.max(0, end - start)) : "00:00";
}


function renderPowerDialSummary(batch, anchor) {
  let panel = document.querySelector("#power-dial-summary");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "power-dial-summary";
    panel.className = "power-dial-summary";
    anchor.parentNode.insertBefore(panel, anchor);
  }

  const lines = batch?.lines || [];
  const status = (line) => String(line?.status || "waiting").toLowerCase();
  const detail = (line) => String(line?.detail || "").toUpperCase();
  const count = (fn) => lines.filter(fn).length;

  const waiting = count((line) => ["waiting", "queued"].includes(status(line)));
  const dials = count((line) => !["waiting", "queued"].includes(status(line)));
  const live = count((line) => ["dialing", "ringing", "amd", "human"].includes(status(line)));
  const answered = count((line) => ["amd", "human", "connected", "machine"].includes(status(line)) || detail(line).includes("ANSWERED") || detail(line).includes("TOOLONG"));
  const agentConnected = count((line) => status(line) === "connected");
  const amd = count((line) => ["amd", "machine"].includes(status(line)) || detail(line).includes("AMD") || detail(line).includes("TOOLONG"));
  const noAnswer = count((line) => status(line) === "no-answer" && !detail(line).includes("TOOLONG") || detail(line).includes("NO_ANSWER"));
  const busy = count((line) => status(line) === "busy" || detail(line).includes("BUSY"));
  const disconnected = count((line) => ["disconnected", "hangup"].includes(status(line)) || detail(line).includes("DISCONNECT"));
  const failed = count((line) => status(line) === "failed");
  const cancelled = count((line) => status(line) === "cancelled");

  const items = [
    ["DIALS", dials],
    ["LIVE", live],
    ["ANSWERED", answered],
    ["AGENT", agentConnected],
    ["WAITING", waiting],
    ["AMD / VM", amd],
    ["NO ANSWER", noAnswer],
    ["BUSY", busy],
    ["DISC", disconnected],
    ["FAILED", failed],
    ["CXL", cancelled],
  ];

  panel.innerHTML = items.map(([label, value]) => `
    <div class="power-dial-metric">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");
}

function renderPowerDialTerminal(batch) {
  const container = $("#power-terminal-lines");
  if (!container) return;
  renderPowerDialSummary(batch, container);
  const lines = batch?.lines || [];
  container.replaceChildren();
  for (let index = 0; index < 10; index += 1) {
    const line = lines[index];
    const row = document.createElement("div");
    row.className = `power-terminal-line ${line?.status || "waiting"}`;
    const slot = document.createElement("b"); slot.textContent = String(index + 1).padStart(2, "0");
    const number = document.createElement("code"); number.textContent = line ? formatDialNumber(line.phone) : "—";
    const name = document.createElement("span"); name.textContent = line?.name || "Awaiting Power Dial";
    const status = document.createElement("strong"); status.textContent = String(line?.status || "waiting").replace(/-/g, " ").toUpperCase();
    const elapsed = document.createElement("time"); elapsed.textContent = line ? terminalElapsed(line) : "00:00";
    const detail = document.createElement("small"); detail.textContent = line?.detail || "Ready";
    row.append(slot, number, name, status, elapsed, detail);
    container.append(row);
  }
  const label = $("#power-terminal-batch");
  label.textContent = batch ? `BATCH ${batch.id.slice(0, 8).toUpperCase()} · ${String(batch.status).toUpperCase()}` : "NO ACTIVE BATCH";
  $("#power-terminal-light").classList.toggle("active", Boolean(batch && !["complete", "stopped"].includes(batch.status)));
}

function loadPowerDialWinner(batch) {
  if (!batch?.winnerLead || state.currentLead?.id === batch.winnerLead.id) return;
  state.currentLead = batch.winnerLead;
  $("#record-state").textContent = `${batch.winnerLead.listName} · HUMAN CONNECTED`;
  $("#destination").value = batch.winnerLead.phone ? `+${batch.winnerLead.phone}` : "";
  $("#call-notes").disabled = false;
  $("#call-notes").value = batch.winnerLead.notes || "";
  $("#notes-save-status").textContent = "SAVED";
  renderCustomer(); renderScript();
}

async function refreshPowerDialStatus() {
  if (state.viewMode !== "advisor" || !state.user?.extension) return;
  try {
    const { batch } = await api("/api/power-dial/status");
    state.powerBatch = batch;
    renderPowerDialTerminal(batch);
    loadPowerDialWinner(batch);
    if (state.powerDial && batch?.status === "complete" && !state.powerDialStarting && !state.currentLead && !state.session) {
      window.setTimeout(() => startPowerDialBatch().catch((error) => setError(error.message)), 650);
    }
  } catch (error) {
    $("#power-terminal-batch").textContent = "STATUS CONNECTION ERROR";
  }
}

function startPowerDialMonitor() {
  clearInterval(state.powerDialTimer);
  refreshPowerDialStatus();
  state.powerDialTimer = setInterval(refreshPowerDialStatus, 750);
}

function playMessageAlert() {
  unlockConnectedBeep();
  const context = connectedBeepContext;
  if (!context) return;
  const start = context.currentTime + 0.01;
  [660, 880].forEach((frequency, index) => {
    const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.frequency.value = frequency; oscillator.connect(gain); gain.connect(context.destination);
    const at = start + index * 0.16; gain.gain.setValueAtTime(0.0001, at); gain.gain.exponentialRampToValueAtTime(0.13, at + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
    oscillator.start(at); oscillator.stop(at + 0.14);
  });
}

function renderMessagePeople(people, unread) {
  const container = $("#message-people"); if (!container) return;
  container.replaceChildren();
  const entries = [{ username: "announcements", displayName: "Announcements", extension: "TEAM", online: true }, ...people];
  for (const person of entries) {
    const count = Number(unread[person.username] || 0);
    const button = document.createElement("button"); button.type = "button";
    button.className = `message-person${state.messageWith === person.username ? " active" : ""}${count ? " unread" : ""}`;
    const name = document.createElement("strong"); name.textContent = person.displayName;
    const detail = document.createElement("small"); detail.textContent = person.username === "announcements" ? "Company-wide notices" : `Ext ${person.extension}`;
    const light = document.createElement("i"); light.className = person.online ? "online" : "";
    button.append(name, detail, light);
    if (count) { const badge = document.createElement("b"); badge.textContent = count; button.append(badge); }
    button.addEventListener("click", () => { state.messageWith = person.username; refreshMessages(true).catch((error) => setError(error.message)); });
    container.append(button);
  }
}

function renderMessageThread(messages) {
  const thread = $("#message-thread"); if (!thread) return;
  thread.replaceChildren();
  if (!state.messageWith) { const empty = document.createElement("p"); empty.textContent = "Select an advisor to start a private conversation."; thread.append(empty); return; }
  if (!messages.length) { const empty = document.createElement("p"); empty.textContent = "No messages yet."; thread.append(empty); }
  for (const message of messages) {
    const bubble = document.createElement("article");
    bubble.className = `message-bubble${message.from === state.user.username ? " mine" : ""}${message.to === "*" ? " announcement" : ""}`;
    const sender = document.createElement("strong"); sender.textContent = message.to === "*" ? `ANNOUNCEMENT · ${message.fromName}` : message.fromName;
    const body = document.createElement("div"); body.textContent = message.body;
    const time = document.createElement("time"); time.textContent = new Date(message.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    bubble.append(sender, body, time); thread.append(bubble);
  }
  thread.scrollTop = thread.scrollHeight;
}

async function refreshMessages(markRead = false) {
  const query = state.messageWith && state.messageWith !== "announcements" ? `?with=${encodeURIComponent(state.messageWith)}` : state.messageWith === "announcements" ? "?with=announcements" : "";
  if (markRead && state.messageWith) await api("/api/messages/read", { method: "POST", body: JSON.stringify({ with: state.messageWith }) });
  const result = await api(`/api/messages${query}`);
  state.messageCanBroadcast = result.canBroadcast;
  const unreadTotal = Object.values(result.unread || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  if (unreadTotal > state.messageUnreadTotal) playMessageAlert();
  state.messageUnreadTotal = unreadTotal;
  $("#advisor-messages").classList.toggle("has-unread", unreadTotal > 0);
  $("#message-waiting").hidden = unreadTotal === 0;
  $("#message-unread-total").textContent = unreadTotal;
  renderMessagePeople(result.people || [], result.unread || {});
  renderMessageThread(result.messages || []);
  const selected = state.messageWith;
  const person = (result.people || []).find((item) => item.username === selected);
  $("#message-conversation-title").textContent = selected === "announcements" ? "Company Announcements" : person ? `${person.displayName} · Ext ${person.extension}` : "Select an advisor";
  const canSend = Boolean(selected && (selected !== "announcements" || result.canBroadcast));
  $("#message-input").disabled = !canSend; $("#message-form button").disabled = !canSend;
  $("#message-input").placeholder = selected === "announcements" && !result.canBroadcast ? "Only Jake can send company announcements" : "Type a message…";
}

function startMessageMonitor() {
  clearInterval(state.messageTimer); refreshMessages().catch(() => {});
  state.messageTimer = setInterval(() => refreshMessages().catch(() => {}), 2000);
}

async function startPowerDialBatch() {
  if (state.powerDialStarting || state.currentLead || state.session) return;
  state.powerDialStarting = true;
  try {
    const result = await api("/api/power-dial/start", { method: "POST", body: "{}" });
    state.powerBatch = result.batch;
    renderPowerDialTerminal(result.batch);
    if (!result.batch) {
      state.powerDial = false;
      $("#power-dial-button").textContent = "Start Power Dial";
      $("#power-dial-button").setAttribute("aria-pressed", "false");
      $("#record-state").textContent = result.message || "NO LEADS AVAILABLE";
    } else {
      $("#record-state").textContent = `DIALING ${result.batch.lines.length} LEADS…`;
    }
  } finally {
    state.powerDialStarting = false;
  }
}

async function stopPowerDialBatch() {
  state.powerDial = false;
  $("#power-dial-button").textContent = "Start Power Dial";
  $("#power-dial-button").setAttribute("aria-pressed", "false");
  const result = await api("/api/power-dial/stop", { method: "POST", body: "{}" });
  state.powerBatch = result.batch;
  renderPowerDialTerminal(result.batch);
  $("#record-state").textContent = state.currentLead ? "SELECT A DISPOSITION" : "POWER DIAL STOPPED";
}

function renderPerformance() {
  const values = state.performance;
  $("#dials-value").textContent = String(values.dials || 0);
  $("#connections-value").textContent = String(values.connections || 0);
  $("#talk-value").textContent = formatDuration(Number(values.talkSeconds || 0) * 1000);
  const period = $("#commission-period").value;
  const amount = Number(values.commissions?.[period] || 0);
  $("#commission-value").textContent = amount.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function refreshPerformance() {
  try {
    state.performance = await api("/api/performance");
    renderPerformance();
  } catch { /* Performance metrics should never block calling. */ }
}

function advisorWaitLabel(seconds) {
  return seconds === null || seconds === undefined ? "—" : formatDuration(Math.max(0, Number(seconds)) * 1000);
}

function tickAdvisorWaitTimes() {
  document.querySelectorAll("[data-wait-start]").forEach((node) => {
    const startedAt = new Date(node.dataset.waitStart).getTime();
    if (Number.isFinite(startedAt)) node.textContent = formatDuration(Date.now() - startedAt);
  });
}

function renderAdvisorWaitTimes(result) {
  const body = $("#advisor-wait-rows"); if (!body) return;
  body.replaceChildren();
  for (const advisor of result.advisors) {
    const row = document.createElement("tr");
    const identity = document.createElement("td"); const name = document.createElement("strong"); name.textContent = advisor.displayName; const extension = document.createElement("small"); extension.textContent = `Ext ${advisor.extension}${advisor.role === "admin" ? " · Manager" : ""}`; identity.append(name, extension);
    const status = document.createElement("td"); const statusBadge = document.createElement("span"); statusBadge.className = `advisor-live-status ${advisor.onCall ? "on-call" : String(advisor.status).toLowerCase() === "ready" ? "ready" : "paused"}`; statusBadge.textContent = advisor.status; status.append(statusBadge);
    const calls = document.createElement("td"); calls.textContent = String(advisor.callsToday);
    const talk = document.createElement("td"); talk.textContent = advisorWaitLabel(advisor.talkSeconds);
    const current = document.createElement("td"); current.className = "current-advisor-wait";
    if (advisor.onCall) current.textContent = "ON CALL";
    else if (advisor.waitStartedAt) { current.dataset.waitStart = advisor.waitStartedAt; current.textContent = advisorWaitLabel(advisor.currentWaitSeconds); }
    else current.textContent = "NOT STARTED";
    const average = document.createElement("td"); average.textContent = advisorWaitLabel(advisor.averageWaitSeconds);
    const longest = document.createElement("td"); longest.textContent = advisorWaitLabel(advisor.longestWaitSeconds);
    const ended = document.createElement("td"); ended.textContent = advisor.lastCallEndedAt ? new Date(advisor.lastCallEndedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    row.append(identity, status, calls, talk, current, average, longest, ended); body.append(row);
  }
  if (!result.advisors.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 8; cell.textContent = "No advisors are configured."; row.append(cell); body.append(row); }
  $("#advisor-wait-refreshed").textContent = `LIVE · ${new Date(result.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  $("#advisor-wait-refreshed").dataset.tone = "online";
  tickAdvisorWaitTimes();
}

async function refreshAdvisorWaitTimes() {
  if (state.viewMode !== "admin") return;
  renderAdvisorWaitTimes(await api("/api/admin/advisor-wait-times"));
}

function startCallTimer() {
  clearInterval(state.callTimer);
  const update = () => { $("#call-timer").textContent = formatDuration(Date.now() - state.callStartedAt); };
  update();
  state.callTimer = setInterval(update, 1000);
}

function stopCallTimer() {
  clearInterval(state.callTimer);
  state.callTimer = null;
  $("#call-timer").textContent = "00:00";
}

async function showApp(user) {
  state.user = user;
  const requestedView = new URLSearchParams(location.search).get("view");
  const adminView = user.role === "admin" && requestedView !== "advisor";
  state.viewMode = adminView ? "admin" : "advisor";
  loginView.hidden = true;
  appView.hidden = false;
  $("#identity").textContent = `${user.displayName} · ${state.viewMode}`;
  document.querySelectorAll(".admin-only").forEach((node) => { node.hidden = !adminView; });
  document.querySelectorAll(".advisor-only").forEach((node) => { node.hidden = adminView; });
  document.querySelectorAll(".dual-view-admin").forEach((node) => { node.hidden = user.role !== "admin"; });
  $("#view-switch").textContent = adminView ? "Advisor View" : "Admin View";
  $("#advisor-panel").hidden = adminView || !user.extension;
  $("#admin-panel").hidden = !adminView;
  $("#workspace-eyebrow").textContent = adminView ? "EMPIREINSIGHTS OPERATIONS" : "TRAVEL EMPIRE OPERATIONS";
  $("#workspace-title").textContent = adminView ? "Admin Command Center" : "Advisor Command Center";
  $("#workspace-description").textContent = adminView ? "Campaigns, lead inventory, distribution, workspace rules, and reporting—without advisor calling controls." : "One workspace for conversations, customer search, packages, scripts, and outcomes.";
  $("#sidebar-title").textContent = adminView ? "ADMIN WORKSPACE" : "ADVISOR WORKSPACE";
  $("#workspace-brand").dataset.view = adminView ? "admin" : "advisor";
  $("#workspace-brand-logo").src = adminView ? "/empire-insights-logo.png" : "/empire-connections-logo.png";
  $("#workspace-brand-logo").alt = adminView ? "EmpireInsights" : "EmpireConnections";
  await Promise.all([loadLayout(), loadCampaigns(), refreshMasonStatus()]);
  if (!adminView && user.extension) {
    try { await connectPhone(); }
    catch (error) {
      state.session = null;
      setPhoneStatus(`Phone unavailable · Ext ${user.extension}`, "offline");
      setError(`Phone connection failed: ${error.message}. The workspace and Sign Off remain available.`);
    }
    startPowerDialMonitor();
    startMessageMonitor();
  }
  await refreshQueue();
  await refreshPerformance();
  if (adminView) {
    await Promise.all([refreshUsers(), refreshMappingCount(), refreshLeadAdmin(), refreshSavedLeadFilters(), refreshLeadCommandCenter(), refreshAdvisorWaitTimes()]);
    clearInterval(state.advisorWaitTimer); clearInterval(state.advisorWaitRefreshTimer);
    state.advisorWaitTimer = setInterval(tickAdvisorWaitTimes, 1000);
    state.advisorWaitRefreshTimer = setInterval(() => refreshAdvisorWaitTimes().catch(() => {}), 30000);
  }
  const welcomeKey = `te-dialer-welcome-${user.username}`;
  if (!localStorage.getItem(welcomeKey)) $("#welcome-modal").hidden = false;
}

async function connectPhone() {
  setPhoneStatus("Connecting…", "pending");
  state.phone = await api("/api/phone");
  const uri = UserAgent.makeURI(`sip:${state.phone.extension}@${state.phone.domain}`);
  state.userAgent = new UserAgent({
    uri,
    displayName: state.phone.displayName,
    authorizationUsername: state.phone.extension,
    authorizationPassword: state.phone.password,
    transportOptions: { server: state.phone.websocket },
    sessionDescriptionHandlerFactoryOptions: { peerConnectionConfiguration: { iceServers: [{ urls: "stun:stun.telnyx.com:3478" }] } },
    delegate: {
      onInvite: async (invitation) => {
        state.session = invitation;
        bindSession(invitation);
        $("#incoming-call").hidden = true;
        $("#incoming-number").textContent = invitation.remoteIdentity?.displayName || invitation.remoteIdentity?.uri?.user || "Incoming caller";
        setPhoneStatus("Connecting incoming call…", "ringing");
        try {
          await invitation.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
        } catch (error) {
          if (state.session === invitation) state.session = null;
          setError(error.message);
          setPhoneStatus(`Ready · Ext ${state.phone.extension}`, "online");
        }
      },
    },
  });
  state.registerer = new Registerer(state.userAgent);
  await state.userAgent.start();
  await state.registerer.register();
  setPhoneStatus(`Ready · Ext ${state.phone.extension}`, "online");
  $("#call-button").disabled = false;
  refreshToList().catch(() => {});
}

let connectedBeepContext = null;

function unlockConnectedBeep() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  connectedBeepContext ||= new AudioContextClass();
  if (connectedBeepContext.state === "suspended") connectedBeepContext.resume().catch(() => {});
}

document.addEventListener("pointerdown", unlockConnectedBeep, { passive: true });
document.addEventListener("keydown", unlockConnectedBeep);

function playConnectedBeep() {
  unlockConnectedBeep();
  const context = connectedBeepContext;
  if (!context) return;
  const start = context.currentTime + 0.01;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.24);
}

function bindSession(session) {
  session.stateChange.addListener((sessionState) => {
    if (sessionState === SessionState.Established) {
      playConnectedBeep();
      state.callStartedAt ||= Date.now();
      startCallTimer();
      recordActivity("call_connected", { direction: session instanceof Inviter ? "outbound" : "inbound", leadId: state.currentLead?.id });
      const receiver = session.sessionDescriptionHandler?.peerConnection?.getReceivers().find((item) => item.track?.kind === "audio");
      if (receiver?.track) remoteAudio.srcObject = new MediaStream([receiver.track]);
      remoteAudio.play().catch(() => {});
      setPhoneStatus("On call", "active");
      if (state.powerBatch?.winnerLeadId) api("/api/power-dial/connected", { method: "POST", body: "{}" }).catch(() => {});
      $("#hangup-button").disabled = false;
      $("#transfer-button").disabled = false;
      $("#call-button").disabled = true;
      $("#incoming-call").hidden = true;
      startMasonListening(session);
    }
    if (sessionState === SessionState.Terminated) {
      const durationSeconds = state.callStartedAt ? Math.round((Date.now() - state.callStartedAt) / 1000) : 0;
      recordActivity("call_ended", { durationSeconds, leadId: state.currentLead?.id });
      state.callStartedAt = null;
      state.session = null;
      remoteAudio.srcObject = null;
      stopCallTimer();
      stopMasonListening();
      setPhoneStatus(`Ready · Ext ${state.phone.extension}`, "online");
      $("#hangup-button").disabled = true;
      $("#transfer-button").disabled = true;
      $("#call-button").disabled = false;
      $("#incoming-call").hidden = true;
      if (state.currentLead) $("#record-state").textContent = "SELECT A DISPOSITION";
      refreshToList().catch(() => {});
      setTimeout(refreshPerformance, 300);
    }
  });
}

async function makeCall() {
  if (state.session) return setError("Finish the current call first.");
  let raw = $("#destination").value.replace(/\D/g, "");
  if (!raw) return setError("Enter a phone number.");
  if (raw.length === 10) raw = `1${raw}`;
  if (!/^1[2-9][0-9]{9}$/.test(raw) && !/^100[1-4]$/.test(raw)) return setError("Enter a valid 10-digit phone number.");
  setError();
  const target = UserAgent.makeURI(`sip:${raw}@${state.phone.domain}`);
  const session = new Inviter(state.userAgent, target, { sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
  state.session = session;
  recordActivity("call_started", { direction: "outbound", destination: `***${raw.slice(-4)}`, leadId: state.currentLead?.id });
  bindSession(session);
  setPhoneStatus("Calling…", "pending");
  try {
    await session.invite();
  } catch (error) {
    if (state.session === session) state.session = null;
    setPhoneStatus(`Ready · Ext ${state.phone.extension}`, "online");
    $("#hangup-button").disabled = true;
    $("#call-button").disabled = false;
    throw error;
  }
}

async function hangup() {
  if (!state.session) return;
  if (state.session.state === SessionState.Established) await state.session.bye();
  else if (state.session.cancel) await state.session.cancel();
}

function pressDigit(digit) {
  if (state.session?.state === SessionState.Established) {
    const sent = state.session.sessionDescriptionHandler?.sendDtmf?.(digit);
    if (sent === false) setError("The call could not send that keypad tone.");
    return;
  }
  const input = $("#destination");
  input.value = `${input.value}${digit}`.slice(0, 18);
  input.focus();
}

async function refreshToList(transferAll = false) {
  if (!state.user?.extension) return;
  const { people } = await api("/api/to");
  const list = $("#to-list");
  list.replaceChildren();
  $("#to-panel-title").textContent = transferAll ? "Transfer to any advisor" : "Available TOs";
  $("#to-panel-note").textContent = transferAll ? "Transfers are sent regardless of availability. Confirm the destination before selecting." : "Only advisors currently available for a live TO are shown.";
  const candidates = people.filter((item) => item.extension !== state.user.extension && (transferAll || item.available));
  for (const person of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `to-person ${person.status}`;
    button.disabled = false;
    const name = document.createElement("span"); name.textContent = `${person.displayName}${person.role === "admin" ? " · Manager TO" : ""}`;
    const detail = document.createElement("small"); detail.textContent = `Ext ${person.extension} · ${person.status}${transferAll && !person.available ? " · transfer anyway" : ""}`;
    button.append(name, detail);
    button.addEventListener("click", () => transferCall(person.extension));
    list.append(button);
  }
  if (!list.children.length) list.textContent = transferAll ? "No other advisors are configured." : "No advisors are currently available for a TO.";
}

async function transferCall(extension) {
  if (!state.session || state.session.state !== SessionState.Established) return setError("Connect a call before selecting a TO.");
  if (typeof state.session.refer !== "function") return setError("This browser session does not support call transfer.");
  const target = UserAgent.makeURI(`sip:${extension}@${state.phone.domain}`);
  if (!target) return setError("The selected TO extension is invalid.");
  setError();
  await state.session.refer(target);
  recordActivity("transfer", { toExtension: extension, leadId: state.currentLead?.id });
  $("#to-panel").hidden = true;
}

async function refreshQueue() {
  try {
    state.queueMembers = (await api("/api/queue")).members;
    const extensions = new Set(state.queueMembers.map((member) => member.extension));
    if (state.user.extension) {
      const joined = extensions.has(state.user.extension);
      $("#queue-status").textContent = joined ? "Receiving incoming calls" : "Not receiving incoming calls";
      $("#join-queue").hidden = joined;
      $("#leave-queue").hidden = !joined;
    }
    if (state.user.role === "admin") document.querySelectorAll("[data-extension]").forEach((input) => { input.checked = extensions.has(input.dataset.extension); });
  } catch (error) {
    setError(error.message);
  }
}

async function setQueue(extension, operation) {
  await api(`/api/queue/${extension}/${operation}`, { method: "POST", body: "{}" });
  await refreshQueue();
}

async function refreshUsers() {
  if (state.user?.role !== "admin") return;
  const result = await api("/api/admin/users");
  state.adminUsers = result.users.filter((user) => user.extension);
  const advisors = result.users.filter((user) => user.role === "advisor");
  const list = $("#advisor-list");
  list.replaceChildren();
  for (const advisor of advisors) {
    const label = document.createElement("label");
    const identity = document.createElement("span");
    identity.textContent = advisor.displayName;
    const detail = document.createElement("small");
    detail.textContent = `${advisor.email} · Extension ${advisor.extension}`;
    identity.append(detail);
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.dataset.extension = advisor.extension;
    toggle.checked = state.queueMembers.some((member) => member.extension === advisor.extension);
    toggle.addEventListener("change", () => setQueue(advisor.extension, toggle.checked ? "join" : "leave").catch((error) => {
      toggle.checked = !toggle.checked;
      setError(error.message);
    }));
    label.append(identity, toggle);
    list.append(label);
  }
  const select = $("#advisor-extension");
  select.replaceChildren(new Option(result.availableExtensions.length ? "Select extension" : "No unassigned extensions", ""));
  for (const extension of result.availableExtensions) select.add(new Option(`Extension ${extension}`, extension));
  $("#create-advisor-button").disabled = result.availableExtensions.length === 0;
}

async function loadLayout() {
  const result = await api("/api/layout");
  state.layout = result.layout;
  state.customerFieldOptions = result.customerFieldOptions;
  renderDispositionRail();
  renderCustomer();
  applySectionOrder();
  if (state.user?.role === "admin") renderLayoutEditor();
}

function applySectionOrder() {
  const panel = $("#advisor-panel");
  if (!panel || !state.layout) return;
  const nodes = new Map([...panel.querySelectorAll(":scope > [data-layout-section]")].map((node) => [node.dataset.layoutSection, node]));
  for (const section of state.layout.sectionOrder) if (nodes.has(section)) panel.append(nodes.get(section));
}

function moveArrayItem(items, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  [items[index], items[target]] = [items[target], items[index]];
  return items;
}

function editorMoveButtons(onMove, index, length) {
  const controls = document.createElement("span");
  const up = document.createElement("button"); up.type = "button"; up.textContent = "↑"; up.disabled = index === 0; up.addEventListener("click", () => onMove(-1));
  const down = document.createElement("button"); down.type = "button"; down.textContent = "↓"; down.disabled = index === length - 1; down.addEventListener("click", () => onMove(1));
  controls.append(up, down);
  return controls;
}

function renderLayoutEditor() {
  if (!state.layout || state.user?.role !== "admin") return;
  [1, 2, 3].forEach((position, index) => {
    const select = $(`#layout-field-${position}`);
    select.replaceChildren(...state.customerFieldOptions.map((field) => new Option(field.label, field.id)));
    select.value = state.layout.customerFields[index];
  });
  const sectionLabels = { phone: "Phone and incoming queue", customer: "Customer information", dispositions: "Dispositions", campaign: "Packages and script", performance: "Performance", "notes-mason": "Notes and Mason" };
  const sectionList = $("#layout-section-list"); sectionList.replaceChildren();
  state.layout.sectionOrder.forEach((section, index) => {
    const row = document.createElement("div"); row.className = "layout-editor-row";
    const label = document.createElement("strong"); label.textContent = sectionLabels[section] || section;
    row.append(label, editorMoveButtons((direction) => { moveArrayItem(state.layout.sectionOrder, index, direction); renderLayoutEditor(); applySectionOrder(); }, index, state.layout.sectionOrder.length));
    sectionList.append(row);
  });
  const dispositionList = $("#layout-disposition-list"); dispositionList.replaceChildren();
  const toneOptions = ["not-interested", "dnc", "callback", "no-answer", "email", "voicemail", "language", "success"];
  state.layout.dispositions.forEach((disposition, index) => {
    const row = document.createElement("div"); row.className = "layout-editor-row disposition-editor-row";
    const input = document.createElement("input"); input.value = disposition.label; input.maxLength = 40; input.addEventListener("input", () => { disposition.label = input.value; });
    const tone = document.createElement("select"); toneOptions.forEach((item) => tone.add(new Option(item.replace(/-/g, " "), item))); tone.value = disposition.tone; tone.addEventListener("change", () => { disposition.tone = tone.value; });
    const controls = editorMoveButtons((direction) => { moveArrayItem(state.layout.dispositions, index, direction); renderLayoutEditor(); renderDispositionRail(); }, index, state.layout.dispositions.length);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-layout-item"; remove.textContent = "Remove"; remove.addEventListener("click", () => { state.layout.dispositions.splice(index, 1); renderLayoutEditor(); renderDispositionRail(); });
    row.append(input, tone, controls, remove); dispositionList.append(row);
  });
}

async function saveLayout() {
  state.layout.customerFields = [1, 2, 3].map((position) => $(`#layout-field-${position}`).value);
  const status = $("#layout-save-status"); status.textContent = "SAVING…";
  const result = await api("/api/admin/layout", { method: "PUT", body: JSON.stringify(state.layout) });
  state.layout = result.layout;
  renderDispositionRail(); renderCustomer(); applySectionOrder(); renderLayoutEditor();
  status.textContent = "SAVED"; status.dataset.tone = "online";
}

function renderDispositionRail() {
  const rail = $("#disposition-rail");
  if (!rail || !state.layout) return;
  rail.replaceChildren();
  for (const disposition of state.layout.dispositions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `disp ${disposition.tone}`;
    button.dataset.dispositionId = disposition.id;
    button.textContent = disposition.label;
    button.addEventListener("click", () => chooseDisposition(disposition, button));
    rail.append(button);
  }
}

function customerValue(fieldId, lead) {
  if (!lead) return fieldId === "campaign" ? "Unassigned" : "—";
  if (fieldId.startsWith("custom:")) return lead.custom?.[fieldId.slice(7)] || "—";
  const values = {
    name: lead.fullName, phone: lead.phone ? `+${lead.phone}` : "—", alternatePhone: lead.alternatePhone ? `+${lead.alternatePhone}` : "—",
    email: lead.email, address: lead.address, zip: lead.zip, timeZone: lead.timeZone, language: lead.language, source: lead.source,
    preferredDestination: lead.preferredDestination, loyaltyProgram: lead.loyaltyProgram, loyaltyTier: lead.loyaltyTier,
    cityState: [lead.city, lead.state].filter(Boolean).join(", "), campaign: lead.campaignName, priorDestination: lead.priorDestination,
  };
  return values[fieldId] || "—";
}

function renderCustomer() {
  const grid = $("#customer-grid");
  if (!grid || !state.layout) return;
  const optionMap = new Map(state.customerFieldOptions.map((field) => [field.id, field.label]));
  const fields = [
    ...state.layout.customerFields.map((id) => ({ id, label: optionMap.get(id) || id })),
    ...state.layout.fixedCustomerFields,
  ];
  grid.replaceChildren();
  for (const field of fields) {
    const cell = document.createElement("div"); const small = document.createElement("small"); const strong = document.createElement("strong");
    small.textContent = field.label; strong.textContent = customerValue(field.id, state.currentLead); cell.append(small, strong); grid.append(cell);
  }
}

async function loadCampaigns() {
  const { campaigns } = await api("/api/campaigns");
  state.campaigns = campaigns;
  const selects = [$("#mapping-campaign")].filter(Boolean);
  for (const select of selects) {
    const current = select.value;
    select.replaceChildren(...campaigns.map((campaign) => new Option(campaign.name, campaign.id)));
    if (campaigns.some((campaign) => campaign.id === current)) select.value = current;
  }
  renderCampaignAccess();
}

function renderCampaignAccess() {
  const select = $("#advisor-campaign-select");
  if (!select) return;
  const activeCampaigns = state.campaigns.filter((campaign) => campaign.status === "active");
  const selected = select.value;
  select.replaceChildren(...activeCampaigns.map((campaign) => new Option(campaign.name, campaign.id)));
  if (activeCampaigns.some((campaign) => campaign.id === selected)) select.value = selected;
  else if (activeCampaigns.some((campaign) => campaign.joined)) select.value = activeCampaigns.find((campaign) => campaign.joined).id;
  updateCampaignAccessControls();
}

function updateCampaignAccessControls() {
  const select = $("#advisor-campaign-select");
  const status = $("#campaign-membership-status");
  const joinButton = $("#join-campaign");
  const leaveButton = $("#leave-campaign");
  if (!select || !status || !joinButton || !leaveButton) return;
  const campaign = state.campaigns.find((item) => item.id === select.value);
  if (!campaign) {
    status.textContent = "NO ACTIVE CAMPAIGNS";
    status.dataset.tone = "offline";
    joinButton.hidden = false; joinButton.disabled = true;
    leaveButton.hidden = false; leaveButton.disabled = true;
    return;
  }
  status.textContent = campaign.joined ? "JOINED · READY FOR ASSIGNED LEADS" : campaign.canJoin ? "AVAILABLE TO JOIN" : "ADMIN ASSIGNMENT REQUIRED";
  status.dataset.tone = campaign.joined ? "online" : "pending";
  joinButton.hidden = false; joinButton.disabled = campaign.joined || !campaign.canJoin;
  leaveButton.hidden = false; leaveButton.disabled = !campaign.joined;
}


function isAdvisorCustomCampaign(campaign) {
  const ext = String(state.user?.extension || "");
  const username = String(state.user?.username || "");
  const fields = [
    campaign.kind, campaign.type, campaign.scope, campaign.visibility,
    campaign.listKind, campaign.assignmentMode, campaign.name
  ].map((value) => String(value || "").toLowerCase());

  const assignedValues = [
    ...(Array.isArray(campaign.assignedExtensions) ? campaign.assignedExtensions : []),
    ...(Array.isArray(campaign.assignedAdvisors) ? campaign.assignedAdvisors : []),
    ...(Array.isArray(campaign.advisors) ? campaign.advisors : []),
    campaign.ownerExtension,
    campaign.ownerUsername,
    campaign.advisorExtension,
    campaign.advisorUsername
  ].map((value) => String(value || ""));

  const explicitlyAssigned = assignedValues.includes(ext) || assignedValues.includes(username);
  const customFlag = Boolean(campaign.custom || campaign.advisorOnly || campaign.exclusive);
  const customWords = fields.some((value) => /custom|exclusive|advisor/.test(value));

  return campaign.status === "active" && (customFlag || customWords || explicitlyAssigned);
}

function refreshAdvisorCustomCampaigns() {
  const select = $("#advisor-custom-campaign-select");
  const status = $("#custom-campaign-membership-status");
  if (!select) return;

  const current = select.value;
  const campaigns = (state.campaigns || []).filter(isAdvisorCustomCampaign);

  select.replaceChildren();
  select.add(new Option(campaigns.length ? "Select assigned custom campaign" : "No custom campaigns assigned", ""));

  for (const campaign of campaigns) {
    select.add(new Option(campaign.name, campaign.id));
  }

  if (campaigns.some((campaign) => campaign.id === current)) select.value = current;

  if (status) {
    const selected = campaigns.find((campaign) => campaign.id === select.value);
    status.textContent = selected
      ? (selected.joined ? "JOINED · READY" : selected.canJoin === false ? "ADMIN ASSIGNMENT REQUIRED" : "AVAILABLE TO JOIN")
      : "SELECT CUSTOM CAMPAIGN";
    status.dataset.tone = selected?.joined ? "online" : "pending";
  }
}

function syncCustomCampaignToEmpire() {
  const custom = $("#advisor-custom-campaign-select");
  const empire = $("#advisor-campaign-select");
  if (!custom || !empire || !custom.value) return false;
  empire.value = custom.value;
  updateCampaignAccessControls();
  refreshAdvisorCustomCampaigns();
  return true;
}

async function setCampaignMembership(operation) {
  const campaignId = $("#advisor-campaign-select").value;
  if (!campaignId) return setError("Choose an active campaign.");
  setError();
  await api(`/api/campaigns/${campaignId}/${operation}`, { method: "POST", body: "{}" });
  await loadCampaigns();
  $("#record-state").textContent = operation === "join" ? "CAMPAIGN JOINED · READY FOR LEAD" : "CAMPAIGN LEFT";
}

function mergeScript(template) {
  const lead = state.currentLead || {};
  const replacements = {
    first_name: lead.firstName || lead.fullName?.split(/\s+/)[0] || "there",
    last_name: lead.lastName || "",
    full_name: lead.fullName || "the customer",
    advisor_name: state.user?.displayName || "your Travel Empire advisor",
  };
  return String(template || "").replace(/\{\{(first_name|last_name|full_name|advisor_name)\}\}/g, (_match, key) => replacements[key]);
}

function renderScript() {
  const campaign = state.campaigns.find((item) => item.id === state.currentLead?.campaignId) || state.campaigns[0];
  const merged = mergeScript(state.currentLead?.scriptTemplate || campaign?.scriptTemplate || "");
  state.currentScript = merged;
  const copy = $("#script-copy"); copy.replaceChildren();
  for (const paragraph of merged.split(/\n\s*\n/).filter(Boolean)) { const p = document.createElement("p"); p.textContent = paragraph; copy.append(p); }
  const note = document.createElement("p"); note.className = "manager-note"; note.textContent = "Merge fields: {{first_name}}, {{last_name}}, {{full_name}}, and {{advisor_name}}."; copy.append(note);
}


function ensureDialModeControls() {
  const nextButton = $("#next-lead-button");
  const powerButton = $("#power-dial-button");
  if (!nextButton || !powerButton || document.querySelector("#dial-mode-panel")) return;

  state.dialMode = state.dialMode || "preview";
  state.dialModeRunning = false;

  const panel = document.createElement("div");
  panel.id = "dial-mode-panel";
  panel.className = "dial-mode-panel";
  panel.innerHTML = `
    <div class="dial-mode-heading">SELECT DIALER</div>
    <div class="dial-mode-buttons">
      <button type="button" class="dial-mode-button active" data-dial-mode="preview">Preview</button>
      <button type="button" class="dial-mode-button" data-dial-mode="power">Power</button>
      <button type="button" class="dial-mode-button" data-dial-mode="predictive">Predict</button>
    </div>
    <label class="last-call-toggle">
      <input type="checkbox" id="last-call-checkbox">
      <span>Last Call</span>
    </label>
  `;

  const phoneStatus = $("#phone-screen-status");
  const phoneScreen = phoneStatus?.closest(".phone-screen, .phone-display, .phone-face, .soft-phone, .softphone, .phone-card") || phoneStatus?.parentElement;
  const fallbackAnchor = nextButton.closest(".card, section, article, div") || nextButton.parentNode;

  if (phoneScreen?.parentNode) phoneScreen.parentNode.insertBefore(panel, phoneScreen.nextSibling);
  else fallbackAnchor.parentNode.insertBefore(panel, fallbackAnchor);

  nextButton.hidden = true;
  powerButton.hidden = true;

  panel.querySelectorAll("[data-dial-mode]").forEach((button) => {
    button.addEventListener("click", () => toggleDialerMode(button.dataset.dialMode));
  });

  setDialMode("preview");
}

function setDialMode(mode) {
  state.dialMode = mode || "preview";

  document.querySelectorAll("[data-dial-mode]").forEach((button) => {
    const active = button.dataset.dialMode === state.dialMode;
    button.classList.toggle("active", active);
    button.classList.toggle("running", active && state.dialModeRunning);
  });

  const nextButton = $("#next-lead-button");
  const powerButton = $("#power-dial-button");
  const lastCall = document.querySelector(".last-call-toggle");

  if (nextButton) nextButton.hidden = true;
  if (powerButton) powerButton.hidden = true;
  if (lastCall) lastCall.hidden = state.dialMode !== "preview";

  if (state.dialMode === "predictive") $("#record-state").textContent = "PREDICTIVE DIALER COMING SOON";
  else if (state.dialMode === "preview" && !state.dialModeRunning && !state.currentLead && !state.session) $("#record-state").textContent = "PREVIEW READY";
  else if (state.dialMode === "power" && !state.dialModeRunning) $("#record-state").textContent = "POWER DIAL READY";
}

async function toggleDialerMode(mode) {
  ensureDialModeControls();

  if (state.dialMode === mode && state.dialModeRunning) {
    return stopSelectedDialer(mode);
  }

  state.dialMode = mode;
  state.dialModeRunning = true;
  const lastCall = $("#last-call-checkbox");
  if (lastCall && mode === "preview") lastCall.checked = false;
  setDialMode(mode);

  if (mode === "preview") return startPreviewCall();

  if (mode === "power") {
    state.powerDial = true;
    return startPowerDialBatch().catch((error) => {
      state.powerDial = false;
      state.dialModeRunning = false;
      setDialMode("power");
      setError(error.message);
    });
  }

  state.dialModeRunning = false;
  setDialMode("predictive");
  $("#record-state").textContent = "PREDICTIVE DIALER COMING SOON";
}

async function stopSelectedDialer(mode = state.dialMode) {
  state.dialModeRunning = false;

  if (mode === "power" || state.powerDial) {
    state.powerDial = false;
    await stopPowerDialBatch().catch((error) => setError(error.message));
  }

  if (mode === "preview") {
    const lastCall = $("#last-call-checkbox");
    if (lastCall) lastCall.checked = true;
    if (state.session) {
      await hangup().catch((error) => setError(error.message));
      $("#record-state").textContent = "STOPPED · SELECT DISPOSITION";
    } else {
      recordActivity("status", { status: "break", reason: "dialer_stopped" }).catch(() => {});
      $("#record-state").textContent = "BREAK · PREVIEW STOPPED";
    }
  }

  setDialMode(mode);
}

async function startPreviewCall() {
  ensureDialModeControls();
  state.dialMode = "preview";
  state.dialModeRunning = true;
  setDialMode("preview");

  if (state.currentLead && !state.session) return makeCall();
  if (!state.currentLead && !state.session) return loadNextLead(true);
}

async function loadNextLead(autoDial = state.powerDial) {
  if (state.currentLead) return setError("Select a disposition for the current lead before loading another.");
  if (state.session) return setError("Finish the current call before loading another lead.");
  setError();
  $("#record-state").textContent = "SELECTING LEAD…";
  const { lead, message } = await api("/api/leads/next");
  if (!lead) {
    state.powerDial = false;
    $("#power-dial-button").textContent = "Start Power Dial";
    $("#power-dial-button").setAttribute("aria-pressed", "false");
    $("#record-state").textContent = message || "NO LEADS AVAILABLE";
    return;
  }
  state.currentLead = lead;
  $("#record-state").textContent = `${lead.listName} · RESERVED FOR YOU`;
  $("#destination").value = lead.phone ? `+${lead.phone}` : "";
  $("#call-notes").disabled = false;
  $("#call-notes").value = lead.notes || "";
  $("#notes-save-status").textContent = "SAVED";
  renderCustomer(); renderScript();
  state.masonTranscript = [];
  $("#mason-transcript").textContent = "The live transcript will appear here during a connected call.";
  recordActivity("lead_loaded", { leadId: lead.id, listId: lead.listId, campaignId: lead.campaignId });
  if (autoDial) await makeCall();
}

function empireInsightsSaleUrl(lead) {
  const url = new URL("https://crm.travelempire.org/wp-admin/admin.php");
  url.searchParams.set("page", "tecrm-new-sale");
  url.searchParams.set("source", "empireconnections");
  const fullNameParts = String(lead?.fullName || "").trim().split(/\s+/).filter(Boolean);
  const firstName = String(lead?.firstName || fullNameParts[0] || "").trim();
  const lastName = String(lead?.lastName || fullNameParts.slice(1).join(" ") || "").trim();
  const customerFields = {
    first_name: firstName,
    last_name: lastName,
    email: lead?.email,
    phone: lead?.phone,
    alternate_phone: lead?.alternatePhone,
    address: lead?.address,
    city: lead?.city,
    state: lead?.state,
    zip: lead?.zip,
  };
  for (const [field, value] of Object.entries(customerFields)) {
    const normalized = String(value || "").trim();
    if (normalized) url.searchParams.set(field, normalized);
  }
  return url.toString();
}

async function chooseDisposition(disposition, button) {
  document.querySelectorAll(".disp").forEach((item) => item.classList.toggle("selected", item === button));
  $("#callback-detail").hidden = disposition.id !== "callback" && disposition.action !== "callback";
  $("#language-detail").hidden = disposition.id !== "language";
  $("#email-detail").hidden = disposition.id !== "email";
  if (!state.currentLead) return recordActivity("disposition", { disposition: disposition.label });
  const callbackAt = $("#callback-at").value;
  if ((disposition.id === "callback" || disposition.action === "callback") && !callbackAt) return setError("Choose the callback date and time.");
  const lead = state.currentLead;
  const isSale = disposition.action === "sale" || disposition.id === "sale";
  const saleUrl = isSale ? empireInsightsSaleUrl(lead) : "";

  if (state.session && !isSale) {
    $("#record-state").textContent = "ENDING CALL…";
    try {
      await hangup();
      const deadline = Date.now() + 5000;
      while (state.session && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (state.session) return setError("The call did not disconnect. Use End Call and try again.");
    } catch (error) {
      return setError(`Could not end the call: ${error.message}`);
    }
  }

  setError();
  await saveNotesNow();
  const result = await api(`/api/leads/${lead.id}/disposition`, { method: "POST", body: JSON.stringify({ dispositionId: disposition.id, callbackAt: callbackAt || undefined }) });
  if (isSale) {
    state.powerDial = false;
    $("#power-dial-button").textContent = "Start Power Dial";
    $("#power-dial-button").setAttribute("aria-pressed", "false");
    state.currentLead = null;
    await api("/api/power-dial/complete", { method: "POST", body: "{}" }).catch(() => {});
    window.open(result.saleUrl || saleUrl, "_blank", "noopener");
    $("#record-state").textContent = "SALE OPENED · FINISH THE CALL";
    return;
  }
  state.currentLead = null;
  $("#destination").value = "";
  $("#call-notes").value = ""; $("#call-notes").disabled = true;
  $("#notes-save-status").textContent = "NO ACTIVE LEAD";
  $("#record-state").textContent = "READY FOR NEXT LEAD";
  renderCustomer(); renderScript();
  refreshPerformance();

  if ((state.dialMode || "preview") === "preview" && state.dialModeRunning) {
    if ($("#last-call-checkbox")?.checked) {
      state.dialModeRunning = false;
      recordActivity("status", { status: "break", reason: "last_call" }).catch(() => {});
      $("#record-state").textContent = "BREAK · NEXT LEAD WAITING";
      return;
    }
    $("#record-state").textContent = "LOADING NEXT PREVIEW CALL…";
    setTimeout(() => loadNextLead(true).catch((error) => setError(error.message)), 650);
    return;
  }

  if (state.powerDial) {
    await api("/api/power-dial/complete", { method: "POST", body: "{}" }).catch(() => {});
    setTimeout(() => startPowerDialBatch().catch((error) => setError(error.message)), 800);
  }
}

async function saveNotesNow() {
  clearTimeout(state.notesTimer);
  if (!state.currentLead) return;
  const status = $("#notes-save-status"); status.textContent = "SAVING…";
  try {
    await api(`/api/leads/${state.currentLead.id}/notes`, { method: "PUT", body: JSON.stringify({ notes: $("#call-notes").value }) });
    state.currentLead.notes = $("#call-notes").value;
    status.textContent = "SAVED"; status.dataset.tone = "online";
  } catch (error) {
    status.textContent = "SAVE ERROR"; status.dataset.tone = "error"; setError(error.message);
  }
}

function scheduleNotesSave() {
  if (!state.currentLead) return;
  $("#notes-save-status").textContent = "UNSAVED";
  clearTimeout(state.notesTimer);
  state.notesTimer = setTimeout(saveNotesNow, 900);
}

const standardCallFields = ["Ignore column", "First name", "Last name", "Full name", "Phone", "Alternate phone", "Email", "Address", "City", "State", "ZIP", "Country", "Time zone", "Lead ID", "Campaign notes", "Loyalty program", "Loyalty tier", "Preferred destination", "Prior destination", "Last purchase", "Language", "Source", "Commission amount"];

function parseCsv(text) {
  const rows = [[]]; let value = ""; let quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"' && quoted && input[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { rows.at(-1).push(value.trim()); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      rows.at(-1).push(value.trim()); value = "";
      if (rows.at(-1).some(Boolean)) rows.push([]); else rows.at(-1).length = 0;
    } else value += character;
  }
  if (value || rows.at(-1).length) rows.at(-1).push(value.trim());
  return rows.filter((row) => row.some(Boolean));
}

function suggestedField(header) {
  const key = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matches = { firstname: "First name", firstn: "First name", fname: "First name", lastname: "Last name", lastn: "Last name", lname: "Last name", fullname: "Full name", name: "Full name", phone: "Phone", phonenumber: "Phone", mobile: "Phone", cell: "Phone", altphone: "Alternate phone", email: "Email", emailaddress: "Email", address: "Address", street: "Address", city: "City", state: "State", province: "State", zip: "ZIP", zipcode: "ZIP", postalcode: "ZIP", country: "Country", cty: "Country", timezone: "Time zone", leadid: "Lead ID", notes: "Campaign notes", comments: "Campaign notes", language: "Language", source: "Source", priortourdestination: "Prior destination", ptd: "Prior destination", resort: "Prior destination", lastpurchase: "Last purchase" };
  return matches[key] || "Ignore column";
}

function mappingSelections() {
  const selections = {};
  document.querySelectorAll("#mapping-rows tr").forEach((row) => { selections[row.dataset.header] = { destination: row.querySelector("select").value, required: row.querySelector("input").checked }; });
  return selections;
}

function renderMappingRows() {
  const previous = mappingSelections(); const body = $("#mapping-rows"); body.replaceChildren();
  const options = [...standardCallFields, ...state.customCallFields.map((field) => `Custom: ${field}`)];
  state.csvHeaders.forEach((header, index) => {
    const row = document.createElement("tr"); row.dataset.header = header;
    const source = document.createElement("td"); source.textContent = header;
    const sample = document.createElement("td"); sample.textContent = state.csvSample[index] || "—";
    const destinationCell = document.createElement("td"); const select = document.createElement("select");
    options.forEach((field) => select.add(new Option(field, field))); select.value = previous[header]?.destination || suggestedField(header); destinationCell.append(select);
    const requiredCell = document.createElement("td"); const required = document.createElement("input"); required.type = "checkbox"; required.checked = previous[header]?.required || select.value === "Phone"; required.setAttribute("aria-label", `Require ${header}`); requiredCell.append(required);
    row.append(source, sample, destinationCell, requiredCell); body.append(row);
  });
  $("#mapping-empty").hidden = state.csvHeaders.length > 0; $("#mapping-table-wrap").hidden = state.csvHeaders.length === 0; $("#save-field-mapping").disabled = state.csvHeaders.length === 0;
}

async function loadCustomLeadFields() {
  if (state.user?.role !== "admin") return;
  const { fields } = await api("/api/admin/lead-fields");
  state.customCallFields = fields.map((field) => String(field.name || field)).filter(Boolean);
}

async function refreshMappingCount() {
  if (state.user?.role !== "admin") return;
  const { mappings } = await api("/api/admin/field-mappings");
  $("#mapping-count").textContent = `${mappings.length} saved mapping${mappings.length === 1 ? "" : "s"}`;
}

function renderLeadAdvisorChoices(users = state.adminUsers) {
  const choices = $("#lead-advisor-choices"); choices.replaceChildren();
  for (const user of users.filter((item) => item.extension)) {
    const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.value = user.extension; input.checked = ["dave", "nick"].includes(user.username);
    label.append(input, document.createTextNode(`${user.displayName} · Ext ${user.extension}${user.role === "admin" ? " · Manager TO" : ""}`)); choices.append(label);
  }
}

async function refreshLeadAdmin() {
  if (state.user?.role !== "admin") return;
  const result = await api("/api/admin/lead-lists");
  state.adminUsers = result.users;
  state.campaigns = result.campaigns;
  await loadCampaigns();
  renderLeadAdvisorChoices(result.users);
  renderWarehouseControls(result.users, result.campaigns);
  const container = $("#lead-list-admin"); container.replaceChildren();
  if (!result.lists.length) { const empty = document.createElement("p"); empty.textContent = "No lead lists imported yet."; container.append(empty); return; }
  for (const list of result.lists) {
    const card = document.createElement("article"); card.className = "lead-list-card";
    const heading = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = list.name;
    const counts = document.createElement("span"); counts.textContent = `${list.available} available · ${list.completed} completed · ${list.total} total`;
    heading.append(name, counts);
    const controls = document.createElement("div"); controls.className = "lead-list-controls";
    const status = document.createElement("select"); ["active", "paused", "archived"].forEach((item) => status.add(new Option(item, item))); status.value = list.status;
    const kind = document.createElement("select"); ["primary", "supplemental"].forEach((item) => kind.add(new Option(item, item))); kind.value = list.kind;
    const blend = document.createElement("input"); blend.type = "number"; blend.min = "0"; blend.max = "100"; blend.value = list.blendPercent; blend.title = "Blend percentage";
    const sharedLabel = document.createElement("label"); const shared = document.createElement("input"); shared.type = "checkbox"; shared.checked = list.shared; sharedLabel.append(shared, document.createTextNode("Shared"));
    const assignments = document.createElement("div"); assignments.className = "lead-list-assignments";
    for (const user of result.users) { const label = document.createElement("label"); const input = document.createElement("input"); input.type = "checkbox"; input.value = user.extension; input.checked = list.assignedExtensions.includes(user.extension); label.append(input, document.createTextNode(user.displayName)); assignments.append(label); }
    const save = document.createElement("button"); save.type = "button"; save.className = "secondary"; save.textContent = "Save List";
    save.addEventListener("click", async () => {
      await api(`/api/admin/lead-lists/${list.id}`, { method: "PATCH", body: JSON.stringify({ status: status.value, kind: kind.value, blendPercent: Number(blend.value), shared: shared.checked, assignedExtensions: [...assignments.querySelectorAll("input:checked")].map((input) => input.value) }) });
      save.textContent = "Saved"; setTimeout(() => { save.textContent = "Save List"; }, 1200);
    });
    controls.append(status, kind, blend, sharedLabel, assignments, save); card.append(heading, controls); container.append(card);
  }
}

const leadFilterFields = [
  ["state", "State"], ["country", "Country"], ["status", "Lead status"], ["disposition", "Disposition"],
  ["advisor", "Advisor / extension"], ["campaign", "Campaign"], ["list", "Lead list"], ["source", "Lead source"],
  ["priorDestination", "Prior destination / resort"], ["attempts", "Call attempts"], ["talkSeconds", "Total talk seconds"],
  ["maxTalkSeconds", "Longest call seconds"], ["createdAt", "Imported date"], ["lastContactAt", "Last contact date"], ["archived", "Archived"],
];
const leadFilterOperators = [
  ["equals", "Equals"], ["not_equals", "Does not equal"], ["contains", "Contains"], ["not_contains", "Does not contain"],
  ["in", "Is one of (comma separated)"], ["not_in", "Is not one of"], ["greater_than", "Greater than"],
  ["greater_or_equal", "Greater than or equal"], ["less_than", "Less than"], ["less_or_equal", "Less than or equal"],
  ["before", "Before date"], ["after", "After date"], ["is_blank", "Is blank"], ["not_blank", "Is not blank"],
];

function renderWarehouseControls(users = state.adminUsers, campaigns = state.campaigns) {
  const bulkAdvisor = $("#lead-bulk-advisor");
  if (bulkAdvisor) {
    const selected = bulkAdvisor.value;
    bulkAdvisor.replaceChildren(new Option("Choose advisor…", ""), ...users.filter((user) => user.extension).map((user) => new Option(`${user.displayName} · Ext ${user.extension}`, user.extension)));
    bulkAdvisor.value = selected;
  }
  const campaignSelect = $("#warehouse-campaign");
  if (campaignSelect) {
    const selected = campaignSelect.value;
    campaignSelect.replaceChildren(...campaigns.map((campaign) => new Option(campaign.name, campaign.id)));
    if ([...campaignSelect.options].some((option) => option.value === selected)) campaignSelect.value = selected;
  }
  const choices = $("#warehouse-advisor-choices");
  if (choices) {
    choices.replaceChildren();
    for (const user of users.filter((item) => item.extension)) {
      const label = document.createElement("label");
      const input = document.createElement("input"); input.type = "checkbox"; input.value = user.extension; input.checked = ["dave", "nick"].includes(user.username);
      label.append(input, document.createTextNode(`${user.displayName} · Ext ${user.extension}`)); choices.append(label);
    }
  }
}

function updateLeadRuleValueInput(row) {
  const field = row.querySelector(".lead-rule-field").value;
  const operator = row.querySelector(".lead-rule-operator").value;
  const input = row.querySelector(".lead-rule-value");
  input.hidden = ["is_blank", "not_blank"].includes(operator);
  input.type = ["attempts", "talkSeconds", "maxTalkSeconds"].includes(field) ? "number" : ["createdAt", "lastContactAt"].includes(field) ? "date" : "text";
  const examples = { state: "VA", country: "Canada", status: "suppressed", disposition: "Not Interested", advisor: "1001", campaign: "Campaign name", list: "Lead list name", source: "Purchased list", priorDestination: "Hilton", archived: "true" };
  input.placeholder = examples[field] || "Value";
}

function addLeadFilterRule(rule = { field: "state", operator: "equals", value: "" }) {
  const container = $("#lead-filter-rows"); if (!container) return;
  const row = document.createElement("div"); row.className = "lead-filter-row";
  const field = document.createElement("select"); field.className = "lead-rule-field";
  leadFilterFields.forEach(([value, label]) => field.add(new Option(label, value))); field.value = rule.field;
  const operator = document.createElement("select"); operator.className = "lead-rule-operator";
  leadFilterOperators.forEach(([value, label]) => operator.add(new Option(label, value))); operator.value = rule.operator;
  const value = document.createElement("input"); value.className = "lead-rule-value"; value.value = rule.value || "";
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "remove-lead-rule"; remove.textContent = "Remove";
  remove.addEventListener("click", () => { row.remove(); if (!container.children.length) addLeadFilterRule(); });
  field.addEventListener("change", () => updateLeadRuleValueInput(row)); operator.addEventListener("change", () => updateLeadRuleValueInput(row));
  row.append(field, operator, value, remove); container.append(row); updateLeadRuleValueInput(row);
}

function currentLeadRules() {
  return [...document.querySelectorAll("#lead-filter-rows .lead-filter-row")].map((row) => ({
    field: row.querySelector(".lead-rule-field").value,
    operator: row.querySelector(".lead-rule-operator").value,
    value: row.querySelector(".lead-rule-value").value,
  })).filter((rule) => ["is_blank", "not_blank"].includes(rule.operator) || rule.value.trim());
}

function currentLeadQuery() {
  return { search: $("#lead-admin-search")?.value || "", rules: currentLeadRules(), match: $("#lead-filter-match")?.value || "all", mode: $("#lead-filter-mode")?.value || "include" };
}

function applySavedFilterToBuilder(filter) {
  $("#lead-filter-mode").value = filter.mode;
  $("#lead-filter-match").value = filter.match;
  $("#lead-filter-name").value = filter.name;
  $("#lead-filter-scope").value = filter.scope;
  const rows = $("#lead-filter-rows"); rows.replaceChildren();
  filter.rules.forEach((rule) => addLeadFilterRule(rule));
  state.leadAdmin.page = 1;
  refreshLeadCommandCenter().catch((error) => setError(error.message));
}

function renderSavedLeadFilters() {
  const container = $("#saved-lead-filters"); if (!container) return;
  container.replaceChildren();
  if (!state.savedLeadFilters.length) { const empty = document.createElement("span"); empty.textContent = "No saved filters yet."; container.append(empty); return; }
  for (const filter of state.savedLeadFilters) {
    const card = document.createElement("article"); card.className = `saved-lead-filter ${filter.enabled ? "enabled" : "disabled"}`;
    const copy = document.createElement("div");
    const name = document.createElement("strong"); name.textContent = filter.name;
    const detail = document.createElement("small"); detail.textContent = `${filter.mode === "exclude" ? "FILTER OUT" : "FILTER IN"} · ${filter.scope === "dialing" ? "LIVE DIALING" : "SAVED VIEW"} · ${filter.rules.length} rule${filter.rules.length === 1 ? "" : "s"}`;
    copy.append(name, detail);
    const controls = document.createElement("div");
    const enabled = document.createElement("label"); const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = filter.enabled; enabled.append(toggle, document.createTextNode("Active"));
    toggle.addEventListener("change", async () => { await api(`/api/admin/lead-filters/${filter.id}`, { method: "PATCH", body: JSON.stringify({ enabled: toggle.checked }) }); await refreshSavedLeadFilters(); });
    const apply = document.createElement("button"); apply.type = "button"; apply.className = "secondary"; apply.textContent = "Apply"; apply.addEventListener("click", () => applySavedFilterToBuilder(filter));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ghost danger"; remove.textContent = "Delete"; remove.addEventListener("click", async () => { await api(`/api/admin/lead-filters/${filter.id}`, { method: "DELETE" }); await refreshSavedLeadFilters(); });
    controls.append(enabled, apply, remove); card.append(copy, controls); container.append(card);
  }
}

async function refreshSavedLeadFilters() {
  if (state.user?.role !== "admin") return;
  const result = await api("/api/admin/lead-filters"); state.savedLeadFilters = result.filters; renderSavedLeadFilters();
}

function displayLeadPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}` : value || "—";
}

function displayLeadDate(value) {
  if (!value) return "—"; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "—";
}

function renderLeadCommandRows(rows) {
  const body = $("#lead-admin-rows"); body.replaceChildren();
  for (const lead of rows) {
    const row = document.createElement("tr");
    const selectCell = document.createElement("td"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = state.leadAdmin.selected.has(lead.id); checkbox.setAttribute("aria-label", `Select ${lead.fullName || "lead"}`);
    checkbox.addEventListener("change", () => { if (checkbox.checked) state.leadAdmin.selected.add(lead.id); else state.leadAdmin.selected.delete(lead.id); updateLeadSelectionCount(); }); selectCell.append(checkbox);
    const customer = document.createElement("td"); const customerName = document.createElement("strong"); customerName.textContent = lead.fullName || "Unnamed lead"; const email = document.createElement("small"); email.textContent = lead.email || "No email"; customer.append(customerName, email);
    const phone = document.createElement("td"); phone.textContent = displayLeadPhone(lead.phone);
    const location = document.createElement("td"); location.textContent = [lead.city, lead.state, lead.country].filter(Boolean).join(", ") || "—";
    const status = document.createElement("td"); const badge = document.createElement("span"); badge.className = `lead-status-badge ${lead.archived ? "archived" : lead.status || "unknown"}`; badge.textContent = lead.archived ? "Archived" : lead.status || "Unknown"; status.append(badge);
    const advisor = document.createElement("td"); advisor.textContent = lead.advisorName || "Unassigned";
    const grouping = document.createElement("td"); const list = document.createElement("strong"); list.textContent = lead.listName || "Unassigned"; const campaign = document.createElement("small"); campaign.textContent = lead.campaignName || "Unassigned"; grouping.append(list, campaign);
    const calls = document.createElement("td"); calls.textContent = String(lead.dials || lead.attempts || 0);
    const talk = document.createElement("td"); talk.textContent = formatDuration(Number(lead.talkSeconds || 0) * 1000);
    const disposition = document.createElement("td"); disposition.textContent = lead.dispositionLabel || lead.dispositionId || "—";
    const contacted = document.createElement("td"); contacted.textContent = displayLeadDate(lead.lastContactAt || lead.lastCallAt);
    row.append(selectCell, customer, phone, location, status, advisor, grouping, calls, talk, disposition, contacted); body.append(row);
  }
  if (!rows.length) { const row = document.createElement("tr"); const cell = document.createElement("td"); cell.colSpan = 11; cell.className = "lead-table-empty"; cell.textContent = "No leads match this view."; row.append(cell); body.append(row); }
}

function updateLeadSelectionCount() {
  $("#lead-selected-count").textContent = String(state.leadAdmin.selected.size);
  const visibleIds = state.leadAdmin.rows.map((lead) => lead.id);
  $("#lead-select-all").checked = Boolean(visibleIds.length) && visibleIds.every((id) => state.leadAdmin.selected.has(id));
}

async function refreshLeadCommandCenter() {
  if (state.user?.role !== "admin" || !$("#lead-admin-rows")) return;
  const result = await api("/api/admin/leads/query", { method: "POST", body: JSON.stringify({ ...currentLeadQuery(), page: state.leadAdmin.page, limit: 50 }) });
  if (state.leadAdmin.page > result.pages) { state.leadAdmin.page = result.pages; return refreshLeadCommandCenter(); }
  state.leadAdmin.pages = result.pages; state.leadAdmin.rows = result.rows; state.leadAdmin.facets = result.facets;
  for (const [key, value] of Object.entries(result.stats)) { const node = $(`#lead-stat-${key}`); if (node) node.textContent = Number(value || 0).toLocaleString(); }
  renderLeadCommandRows(result.rows); updateLeadSelectionCount();
  $("#lead-page-label").textContent = `Page ${result.page} of ${result.pages}`;
  $("#lead-prev-page").disabled = result.page <= 1; $("#lead-next-page").disabled = result.page >= result.pages;
}

async function saveLeadFilter() {
  const payload = { name: $("#lead-filter-name").value, mode: $("#lead-filter-mode").value, match: $("#lead-filter-match").value, scope: $("#lead-filter-scope").value, rules: currentLeadRules(), enabled: true };
  await api("/api/admin/lead-filters", { method: "POST", body: JSON.stringify(payload) });
  await refreshSavedLeadFilters(); setError(`Saved ${payload.mode === "exclude" ? "Filter Out" : "Filter In"} rule: ${payload.name}`);
}

async function applyLeadBulkAction() {
  const ids = [...state.leadAdmin.selected]; const action = $("#lead-bulk-action").value;
  const result = await api("/api/admin/leads/bulk", { method: "POST", body: JSON.stringify({ ids, action, extension: $("#lead-bulk-advisor").value }) });
  state.leadAdmin.selected.clear(); await Promise.all([refreshLeadCommandCenter(), refreshLeadAdmin()]); setError(`Updated ${result.changed} lead${result.changed === 1 ? "" : "s"}.`);
}

async function createListFromWarehouse() {
  const assignedExtensions = [...document.querySelectorAll("#warehouse-advisor-choices input:checked")].map((input) => input.value);
  const payload = {
    name: $("#warehouse-list-name").value, campaignId: $("#warehouse-campaign").value, assignmentMode: $("#warehouse-assignment-mode").value,
    kind: $("#warehouse-list-kind").value, blendPercent: Number($("#warehouse-blend-percent").value), retryMinutes: Number($("#warehouse-retry-minutes").value),
    assignedExtensions, ids: [...state.leadAdmin.selected], filter: currentLeadQuery(),
  };
  const result = await api("/api/admin/leads/create-list", { method: "POST", body: JSON.stringify(payload) });
  state.leadAdmin.selected.clear(); await Promise.all([refreshLeadCommandCenter(), refreshLeadAdmin()]);
  const counts = Object.entries(result.byAdvisor || {}).filter(([, count]) => count).map(([extension, count]) => `Ext ${extension}: ${count}`).join(" · ");
  setError(`Created ${result.list.name} with ${result.assigned.toLocaleString()} leads${counts ? ` · ${counts}` : ""}.`);
}

function resetLeadImportReview() {
  state.pendingLeadImport = null;
  $("#lead-mapping-step").hidden = false;
  $("#lead-mapping-review").hidden = true;
}

function closeLeadImport() {
  resetLeadImportReview();
  $("#lead-import-modal").hidden = true;
  state.csvHeaders = []; state.csvRows = []; state.csvSample = [];
  $("#lead-csv").value = "";
  $("#mapping-name").value = "";
  renderMappingRows();
}

function collectLeadImportPayload() {
  const allFields = [...document.querySelectorAll("#mapping-rows tr")].map((row) => ({
    source: row.dataset.header,
    destination: row.querySelector("select").value,
    required: row.querySelector("input").checked,
    sample: row.children[1]?.textContent || "—",
  }));
  const fields = allFields.filter((field) => field.destination !== "Ignore column").map(({ source, destination, required }) => ({ source, destination, required }));
  if (!fields.some((field) => field.destination === "Phone")) throw new Error("Map one CSV column to Phone.");
  const destinations = fields.map((field) => field.destination.toLowerCase());
  if (new Set(destinations).size !== destinations.length) throw new Error("Each EmpireConnections field may be mapped only once.");
  const assignedExtensions = [...document.querySelectorAll("#lead-advisor-choices input:checked")].map((input) => input.value);
  const assignmentMode = $("#lead-assignment-mode").value;
  if (assignmentMode !== "shared" && !assignedExtensions.length) throw new Error("Choose at least one advisor or select Shared.");
  if (assignmentMode === "split" && assignedExtensions.length < 2) throw new Error("Choose at least two advisors for an even split.");
  const name = $("#mapping-name").value.trim();
  if (name.length < 2) throw new Error("Enter a lead-list name.");
  return {
    payload: {
      campaignId: $("#mapping-campaign").value,
      name,
      headers: state.csvHeaders,
      rows: state.csvRows,
      fields,
      kind: $("#lead-list-kind").value,
      blendPercent: Number($("#lead-blend-percent").value),
      retryMinutes: Number($("#lead-retry-minutes").value),
      assignmentMode,
      assignedExtensions,
      mappingVerified: true,
    },
    allFields,
  };
}

function showLeadMappingReview() {
  setError();
  let review;
  try { review = collectLeadImportPayload(); }
  catch (error) { return setError(error.message); }
  state.pendingLeadImport = review.payload;
  const campaign = state.campaigns.find((item) => item.id === review.payload.campaignId);
  const advisorNames = review.payload.assignedExtensions.map((extension) => state.adminUsers.find((user) => user.extension === extension)?.displayName || `Ext ${extension}`);
  const mappedCount = review.allFields.filter((field) => field.destination !== "Ignore column").length;
  const ignoredCount = review.allFields.length - mappedCount;
  $("#mapping-review-summary").textContent = `${review.payload.rows.length.toLocaleString()} data rows · ${mappedCount} mapped columns · ${ignoredCount} ignored columns`;
  $("#mapping-review-details").textContent = `${review.payload.name} · ${campaign?.name || "Campaign"} · ${review.payload.assignmentMode === "split" ? "Even split" : review.payload.assignmentMode === "shared" ? "Shared" : "Advisor pool"} · ${advisorNames.join(", ") || "All joined advisors"}`;
  const body = $("#mapping-review-rows"); body.replaceChildren();
  for (const field of review.allFields) {
    const row = document.createElement("tr");
    const source = document.createElement("td"); source.textContent = field.source;
    const sample = document.createElement("td"); sample.textContent = field.sample;
    const destination = document.createElement("td"); destination.textContent = field.destination;
    if (field.destination.startsWith("Custom: ")) destination.className = "custom-mapping-value";
    const required = document.createElement("td"); required.textContent = field.required ? "Required" : "Optional";
    row.append(source, sample, destination, required); body.append(row);
  }
  $("#lead-mapping-step").hidden = true;
  $("#lead-mapping-review").hidden = false;
}

async function importLeadList() {
  const payload = state.pendingLeadImport;
  if (!payload?.mappingVerified) return setError("Review and verify the field mapping before importing.");
  const button = $("#confirm-lead-import"); button.disabled = true; button.textContent = "Importing…";
  try {
    const result = await api("/api/admin/lead-lists/import", { method: "POST", body: JSON.stringify(payload) });
    await api("/api/admin/field-mappings", { method: "POST", body: JSON.stringify({ campaignId: payload.campaignId, name: payload.name, fields: payload.fields }) });
    closeLeadImport(); await Promise.all([refreshLeadAdmin(), refreshMappingCount(), refreshLeadCommandCenter()]);
    const counts = Object.entries(result.stats.byAdvisor || {}).filter(([, count]) => count).map(([extension, count]) => `Ext ${extension}: ${count}`).join(" · ");
    setError(`Imported ${result.stats.imported} leads${counts ? ` · ${counts}` : ""} · ${result.stats.duplicates} duplicates · ${result.stats.invalid} invalid · ${result.stats.dnc} DNC skipped`);
  } finally {
    button.disabled = false; button.textContent = "Confirm and Import Leads";
  }
}

async function refreshMasonStatus() {
  try {
    const result = await api("/api/mason/status");
    state.masonConfigured = result.configured;
    const badge = $("#mason-live-status");
    badge.textContent = result.configured ? "READY" : "NEEDS API KEY";
    badge.dataset.tone = result.configured ? "online" : "offline";
  } catch { state.masonConfigured = false; }
}

function appendTranscript(text) {
  if (!text) return;
  state.masonTranscript.push(text);
  state.masonTranscript = state.masonTranscript.slice(-60);
  const transcript = $("#mason-transcript"); transcript.textContent = state.masonTranscript.join(" "); transcript.scrollTop = transcript.scrollHeight;
}

async function uploadMasonAudio(blob) {
  if (!blob.size || !state.masonConfigured) return;
  try {
    const response = await fetch("/api/mason/transcribe", { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result.text) appendTranscript(result.text);
    else if (!response.ok) $("#mason-live-status").textContent = "TRANSCRIPT ERROR";
  } catch { $("#mason-live-status").textContent = "TRANSCRIPT ERROR"; }
}

function recordMasonChunk() {
  const capture = state.masonCapture;
  if (!capture?.active) return;
  const chunks = [];
  const recorder = new MediaRecorder(capture.destination.stream, capture.options);
  capture.recorder = recorder;
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  recorder.addEventListener("stop", () => {
    if (chunks.length) uploadMasonAudio(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    if (capture.active) recordMasonChunk();
  }, { once: true });
  recorder.start();
  capture.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 9000);
}

function startMasonListening(session) {
  if (!state.masonConfigured || typeof MediaRecorder === "undefined") return;
  try {
    const peerConnection = session.sessionDescriptionHandler?.peerConnection;
    const tracks = [
      peerConnection?.getSenders().find((item) => item.track?.kind === "audio")?.track,
      peerConnection?.getReceivers().find((item) => item.track?.kind === "audio")?.track,
    ].filter(Boolean);
    if (!tracks.length) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass();
    const destination = context.createMediaStreamDestination();
    const sources = tracks.map((track) => context.createMediaStreamSource(new MediaStream([track])));
    sources.forEach((source) => source.connect(destination));
    const mimeType = MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : MediaRecorder.isTypeSupported?.("audio/webm") ? "audio/webm" : "";
    state.masonCapture = { active: true, context, destination, sources, recorder: null, timer: null, options: mimeType ? { mimeType } : {} };
    $("#mason-live-status").textContent = "LISTENING"; $("#mason-live-status").dataset.tone = "active";
    recordMasonChunk();
  } catch (error) {
    $("#mason-live-status").textContent = "AUDIO UNAVAILABLE";
    setError(`Mason could not access call audio: ${error.message}`);
  }
}

function stopMasonListening() {
  const capture = state.masonCapture;
  if (!capture) return;
  capture.active = false;
  clearTimeout(capture.timer);
  if (capture.recorder?.state === "recording") capture.recorder.stop();
  capture.sources.forEach((source) => source.disconnect());
  capture.context.close().catch(() => {});
  state.masonCapture = null;
  const badge = $("#mason-live-status"); badge.textContent = state.masonConfigured ? "READY" : "NEEDS API KEY"; badge.dataset.tone = state.masonConfigured ? "online" : "offline";
}

async function askMason(question) {
  const answerNode = $("#mason-answer"); answerNode.hidden = false; answerNode.textContent = "Mason is thinking…";
  try {
    const result = await api("/api/mason/ask", { method: "POST", body: JSON.stringify({ question, transcript: state.masonTranscript.join(" "), script: state.currentScript, lead: state.currentLead }) });
    answerNode.textContent = result.answer;
    recordActivity("mason", { leadId: state.currentLead?.id, request: question.slice(0, 120) });
  } catch (error) {
    answerNode.textContent = error.message;
  }
}

on("#create-advisor-form", "submit", async (event) => {
  event.preventDefault(); setError();
  try {
    const result = await api("/api/admin/users", { method: "POST", body: JSON.stringify({ displayName: $("#advisor-name").value, email: $("#advisor-email").value, extension: $("#advisor-extension").value }) });
    $("#advisor-created").hidden = false; $("#advisor-created-value").textContent = `${result.user.displayName} is assigned to extension ${result.user.extension}. Their EmpireInsights login opens EmpireConnection automatically.`;
    event.target.reset(); await Promise.all([refreshUsers(), refreshLeadAdmin()]);
  } catch (error) { setError(error.message); }
});

on("#logout-button", "click", async () => { await api("/api/logout", { method: "POST", body: "{}" }); location.href = "https://crm.travelempire.org/wp-admin/admin.php?page=tecrm-dashboard"; });
on("#view-switch", "click", () => { location.href = state.viewMode === "admin" ? "/?view=advisor" : "/"; });
on("#advisor-global-search", "submit", (event) => {
  event.preventDefault();
  const query = $("#advisor-global-search-input").value.trim();
  if (query.length < 2) return setError("Enter at least two characters to search EmpireInsights.");
  location.href = `https://crm.travelempire.org/wp-admin/admin.php?page=tecrm-customers&s=${encodeURIComponent(query)}`;
});
on("#call-button", "click", () => makeCall().catch((error) => setError(error.message)));
on("#hangup-button", "click", () => hangup().catch((error) => setError(error.message)));
document.querySelectorAll("[data-digit]").forEach((button) => button.addEventListener("click", () => pressDigit(button.dataset.digit)));
on("#to-button", "click", async () => { $("#to-panel").hidden = !$("#to-panel").hidden; if (!$("#to-panel").hidden) await refreshToList(false).catch((error) => setError(error.message)); });
on("#transfer-button", "click", async () => { $("#to-panel").hidden = false; await refreshToList(true).catch((error) => setError(error.message)); });
on("#join-queue", "click", () => setQueue(state.user.extension, "join").catch((error) => setError(error.message)));
on("#leave-queue", "click", () => setQueue(state.user.extension, "leave").catch((error) => setError(error.message)));
on("#advisor-campaign-select", "change", updateCampaignAccessControls);
on("#advisor-custom-campaign-select", "change", () => { syncCustomCampaignToEmpire(); refreshAdvisorCustomCampaigns(); });
on("#join-custom-campaign", "click", () => {
  if (!syncCustomCampaignToEmpire()) return setError("Choose an assigned custom campaign.");
  return setCampaignMembership("join").then(refreshAdvisorCustomCampaigns).catch((error) => setError(error.message));
});
on("#leave-custom-campaign", "click", () => {
  if (!syncCustomCampaignToEmpire()) return setError("Choose an assigned custom campaign.");
  return setCampaignMembership("leave").then(refreshAdvisorCustomCampaigns).catch((error) => setError(error.message));
});
on("#join-campaign", "click", () => setCampaignMembership("join").catch((error) => setError(error.message)));
on("#leave-campaign", "click", () => setCampaignMembership("leave").catch((error) => setError(error.message)));
on("#next-lead-button", "click", () => {
  ensureDialModeControls();
  if ((state.dialMode || "preview") === "preview") return startPreviewCall().catch((error) => setError(error.message));
  return loadNextLead(false).catch((error) => setError(error.message));
});
on("#power-dial-button", "click", () => {
  ensureDialModeControls();
  state.dialMode = "power";
  setDialMode("power");
  if (state.powerDial) return stopPowerDialBatch().catch((error) => setError(error.message));
  state.powerDial = true;
  $("#power-dial-button").textContent = "Stop Power Dial";
  $("#power-dial-button").setAttribute("aria-pressed", "true");
  startPowerDialBatch().catch((error) => {
    state.powerDial = false;
    $("#power-dial-button").textContent = "Start Power Dial";
    $("#power-dial-button").setAttribute("aria-pressed", "false");
    setError(error.message);
  });
});
ensureDialModeControls();

on("#message-form", "submit", async (event) => {
  event.preventDefault();
  const body = $("#message-input").value.trim(); if (!body || !state.messageWith) return;
  const to = state.messageWith === "announcements" ? "*" : state.messageWith;
  try { await api("/api/messages", { method: "POST", body: JSON.stringify({ to, body }) }); $("#message-input").value = ""; await refreshMessages(true); }
  catch (error) { setError(error.message); }
});
on("#call-notes", "input", scheduleNotesSave);
on("#call-notes", "blur", saveNotesNow);
on("#commission-period", "change", renderPerformance);

async function openLeadImport() {
  await Promise.all([refreshLeadAdmin(), loadCustomLeadFields()]);
  resetLeadImportReview();
  renderMappingRows();
  $("#lead-import-modal").hidden = false;
}
on("#open-lead-import", "click", () => openLeadImport().catch((error) => setError(error.message)));
on("#warehouse-open-import", "click", () => openLeadImport().catch((error) => setError(error.message)));
on("#close-lead-import", "click", closeLeadImport);
on("#cancel-lead-import", "click", closeLeadImport);
on("#refresh-lead-lists", "click", () => refreshLeadAdmin().catch((error) => setError(error.message)));
on("#lead-csv", "change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  const rows = parseCsv(await file.text()); state.csvHeaders = rows[0] || []; state.csvRows = rows.slice(1); state.csvSample = state.csvRows[0] || [];
  if (new Set(state.csvHeaders.map((header) => header.toLowerCase())).size !== state.csvHeaders.length) {
    state.csvHeaders = []; state.csvRows = []; state.csvSample = [];
    renderMappingRows();
    return setError("The CSV contains duplicate column headings. Rename them before importing.");
  }
  if (!$("#mapping-name").value) $("#mapping-name").value = file.name.replace(/\.csv$/i, "");
  resetLeadImportReview();
  renderMappingRows();
});
on("#add-call-field", "click", async () => {
  const input = $("#custom-call-field"); const name = input.value.trim().replace(/\s+/g, " "); if (!name) return setError("Enter a new field name.");
  try {
    const result = await api("/api/admin/lead-fields", { method: "POST", body: JSON.stringify({ name }) });
    const fieldName = String(result.field.name || name);
    if (!state.customCallFields.some((item) => item.toLowerCase() === fieldName.toLowerCase())) state.customCallFields.push(fieldName);
    if (!state.customerFieldOptions.some((item) => item.id.toLowerCase() === `custom:${fieldName}`.toLowerCase())) state.customerFieldOptions.push({ id: `custom:${fieldName}`, label: fieldName });
    input.value = ""; renderMappingRows(); setError(`${result.created ? "Created" : "Loaded"} custom field: ${fieldName}`);
  } catch (error) { setError(error.message); }
});
on("#save-field-mapping", "click", showLeadMappingReview);
on("#back-to-lead-mapping", "click", resetLeadImportReview);
on("#confirm-lead-import", "click", () => importLeadList().catch((error) => setError(error.message)));
on("#create-campaign-form", "submit", async (event) => {
  event.preventDefault();
  try { await api("/api/admin/campaigns", { method: "POST", body: JSON.stringify({ name: $("#campaign-name").value }) }); event.target.reset(); await Promise.all([loadCampaigns(), refreshLeadAdmin()]); }
  catch (error) { setError(error.message); }
});

on("#add-lead-filter-rule", "click", () => addLeadFilterRule());
on("#save-lead-filter", "click", () => saveLeadFilter().catch((error) => setError(error.message)));
on("#lead-admin-apply", "click", () => { state.leadAdmin.page = 1; state.leadAdmin.selected.clear(); refreshLeadCommandCenter().catch((error) => setError(error.message)); });
on("#lead-admin-search", "keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("#lead-admin-apply").click(); } });
on("#lead-admin-clear", "click", () => {
  $("#lead-admin-search").value = ""; $("#lead-filter-name").value = ""; $("#lead-filter-mode").value = "include"; $("#lead-filter-match").value = "all";
  $("#lead-filter-rows").replaceChildren(); addLeadFilterRule(); state.leadAdmin.page = 1; state.leadAdmin.selected.clear(); refreshLeadCommandCenter().catch((error) => setError(error.message));
});
on("#lead-select-all", "change", (event) => {
  for (const lead of state.leadAdmin.rows) { if (event.target.checked) state.leadAdmin.selected.add(lead.id); else state.leadAdmin.selected.delete(lead.id); }
  renderLeadCommandRows(state.leadAdmin.rows); updateLeadSelectionCount();
});
on("#lead-prev-page", "click", () => { if (state.leadAdmin.page > 1) { state.leadAdmin.page -= 1; refreshLeadCommandCenter().catch((error) => setError(error.message)); } });
on("#lead-next-page", "click", () => { if (state.leadAdmin.page < state.leadAdmin.pages) { state.leadAdmin.page += 1; refreshLeadCommandCenter().catch((error) => setError(error.message)); } });
on("#apply-lead-bulk", "click", () => applyLeadBulkAction().catch((error) => setError(error.message)));
on("#create-list-from-filter", "click", () => createListFromWarehouse().catch((error) => setError(error.message)));

on("#add-disposition", "click", () => {
  const id = `custom-${Date.now().toString(36)}`;
  state.layout.dispositions.push({ id, label: "New Disposition", action: "complete", tone: "not-interested" });
  renderLayoutEditor(); renderDispositionRail();
});
on("#save-layout", "click", () => saveLayout().catch((error) => { $("#layout-save-status").textContent = "SAVE ERROR"; setError(error.message); }));

document.querySelectorAll("[data-package-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-package-tab]").forEach((item) => item.classList.toggle("active", item === button));
    $("#package-zoom").hidden = button.dataset.packageTab !== "zoom";
    $("#package-person").hidden = button.dataset.packageTab !== "person";
  });
});

on("#advisor-status", "change", async (event) => {
  if (!state.user?.extension) return;
  const ready = event.target.value === "Ready";
  recordActivity("status", { status: event.target.value });
  try { await setQueue(state.user.extension, ready ? "join" : "leave"); await refreshToList(); }
  catch (error) { setError(error.message); }
});

on("#mason-form", "submit", (event) => { event.preventDefault(); const question = $("#mason-question").value.trim(); if (question) { askMason(question); $("#mason-question").value = ""; } });
document.querySelectorAll("[data-mason-prompt]").forEach((button) => button.addEventListener("click", () => askMason(button.dataset.masonPrompt)));

function dismissWelcome(startShift = false) {
  if (!state.user) return;
  localStorage.setItem(`te-dialer-welcome-${state.user.username}`, "seen");
  $("#welcome-modal").hidden = true;
  if (startShift && state.user.extension) {
    recordActivity("shift_start");
    $("#advisor-status").value = "Ready";
    setQueue(state.user.extension, "join").catch((error) => setError(error.message));
  }
}

on("#welcome-close", "click", () => dismissWelcome(false));
on("#welcome-start", "click", () => dismissWelcome(true));

if ($("#lead-filter-rows") && !$("#lead-filter-rows").children.length) addLeadFilterRule();

const sidebar = $(".sidebar");
const sidebarToggle = $("#sidebar-toggle");
if (sidebar && sidebarToggle) {
  const setSidebarOpen = (open) => {
    sidebar.classList.toggle("sidebar-open", open);
    sidebarToggle.setAttribute("aria-expanded", String(open));
    sidebarToggle.setAttribute("aria-label", open ? "Collapse EmpireConnections menu" : "Expand EmpireConnections menu");
    sidebarToggle.title = open ? "Collapse EmpireConnections menu" : "Expand EmpireConnections menu";
  };
  sidebarToggle.addEventListener("click", () => setSidebarOpen(!sidebar.classList.contains("sidebar-open")));
  sidebar.addEventListener("mouseenter", () => setSidebarOpen(true));
  sidebar.addEventListener("mouseleave", () => setSidebarOpen(false));
  sidebar.addEventListener("focusin", () => setSidebarOpen(true));
  sidebar.addEventListener("focusout", () => window.setTimeout(() => { if (!sidebar.contains(document.activeElement)) setSidebarOpen(false); }, 0));
}

api("/api/me").then(({ user }) => showApp(user)).catch(() => { loginView.hidden = false; });

import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import helmet from "helmet";
import { loadCallHistory } from "./call-history.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const publicHost = process.env.PUBLIC_HOST || "dialer.travelempire.org";
const dataDir = process.env.DATA_DIR || "/data";
const secretsDir = process.env.SECRETS_DIR || "/run/travel-empire";
const usersPath = path.join(dataDir, "users.json");
const campaignsPath = path.join(dataDir, "campaigns.json");
const dispositionsPath = path.join(dataDir, "dispositions.json");
const activityPath = path.join(dataDir, "activity.jsonl");
const fieldMappingsPath = path.join(dataDir, "field-mappings.json");
const layoutPath = path.join(dataDir, "layout.json");
const leadsPath = path.join(dataDir, "leads.json");
const connectionsPath = path.join(dataDir, "connections.json");
const leadListsPath = path.join(dataDir, "lead-lists.json");
const dncPath = path.join(dataDir, "dnc.json");
const leadFiltersPath = path.join(dataDir, "lead-filters.json");
const customLeadFieldsPath = path.join(dataDir, "custom-lead-fields.json");
const advisorMessagesPath = path.join(dataDir, "advisor-messages.json");
const advisorPresence = new Map();
const powerDialBatchSize = Math.min(10, Math.max(1, Number(process.env.POWER_DIAL_BATCH_SIZE || 10)));
const powerDialBatches = new Map();
const powerDialActionIndex = new Map();
const powerDialChannelIndex = new Map();
const openAiApiKey = String(process.env.OPENAI_API_KEY || "").trim();
const masonModel = process.env.OPENAI_MASON_MODEL || "gpt-5.6-luna";
const transcriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-transcribe";

const customerFieldOptions = [
  { id: "name", label: "Name" },
  { id: "phone", label: "Phone" },
  { id: "alternatePhone", label: "Alternate phone" },
  { id: "email", label: "Email" },
  { id: "address", label: "Address" },
  { id: "zip", label: "ZIP" },
  { id: "timeZone", label: "Time zone" },
  { id: "language", label: "Language" },
  { id: "source", label: "Source" },
  { id: "preferredDestination", label: "Preferred destination" },
  { id: "loyaltyProgram", label: "Loyalty program" },
  { id: "loyaltyTier", label: "Loyalty tier" },
];

const fixedCustomerFields = [
  { id: "cityState", label: "City / State" },
  { id: "campaign", label: "Campaign" },
  { id: "priorDestination", label: "Prior destination" },
];

const defaultDispositions = [
  { id: "not-interested", label: "Not Interested", action: "complete", tone: "not-interested" },
  { id: "dnc", label: "DNC", action: "suppress", tone: "dnc" },
  { id: "callback", label: "Call Back", action: "callback", tone: "callback" },
  { id: "no-answer", label: "No Answer", action: "retry", tone: "no-answer" },
  { id: "email", label: "Send Email", action: "email", tone: "email" },
  { id: "voicemail", label: "Voicemail", action: "retry", tone: "voicemail" },
  { id: "language", label: "Language Barrier", action: "language", tone: "language" },
  { id: "sale", label: "Sale", action: "sale", tone: "success" },
];

const defaultLayout = {
  layoutVersion: 2,
  dispositions: defaultDispositions,
  customerFields: ["name", "phone", "email"],
  fixedCustomerFields,
  sectionOrder: ["phone", "dispositions", "customer", "campaign", "performance", "notes-mason"],
};

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(advisorMessagesPath)) fs.writeFileSync(advisorMessagesPath, "[]\n", { mode: 0o600 });

function parseKeyValueFile(filePath) {
  return Object.fromEntries(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

const advisorSecrets = parseKeyValueFile(path.join(secretsDir, "advisor-credentials"));
const amiSecrets = parseKeyValueFile(path.join(secretsDir, "ami-credentials"));
const sessionSecret = fs.readFileSync(path.join(secretsDir, "app-session-secret"), "utf8").trim();
const ssoSecret = fs.readFileSync(path.join(secretsDir, "crm-sso-secret"), "utf8").trim();

function readUsers() {
  return JSON.parse(fs.readFileSync(usersPath, "utf8"));
}

function writeUsers(users) {
  const temporary = `${usersPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, usersPath);
}

async function seedUsers() {
  if (fs.existsSync(usersPath)) return;
  const definitions = [
    { username: "admin", email: "be.theengine@gmail.com", role: "admin", displayName: "Jake Adams", extension: "1003" },
    { username: "dave", email: "dave@travelempire.org", role: "advisor", displayName: "Dave Sterling", extension: "1001" },
    { username: "nick", email: "nick@travelempire.org", role: "advisor", displayName: "Nick Zurko", extension: "1002" },
  ];
  const users = definitions.map((definition) => ({
      ...definition,
      passwordHash: "sso-only",
      mustChangePassword: false,
      enabled: true,
  }));
  writeUsers(users);
}

await seedUsers();

function reconcileCoreUsers() {
  const core = [
    { username: "admin", email: "be.theengine@gmail.com", role: "admin", displayName: "Jake Adams", extension: "1003" },
    { username: "dave", email: "dave@travelempire.org", role: "advisor", displayName: "Dave Sterling", extension: "1001" },
    { username: "nick", email: "nick@travelempire.org", role: "advisor", displayName: "Nick Zurko", extension: "1002" },
  ];
  const users = readUsers();
  const coreNames = new Set(core.map((definition) => definition.username));
  const coreExtensions = new Set(core.map((definition) => definition.extension));
  for (const candidate of users) {
    if (!coreNames.has(candidate.username) && coreExtensions.has(candidate.extension)) candidate.extension = null;
  }
  for (const definition of core) {
    const existing = users.find((candidate) => candidate.email === definition.email || candidate.username === definition.username);
    if (existing) Object.assign(existing, definition, { passwordHash: "sso-only", mustChangePassword: false, enabled: true });
    else users.push({ ...definition, passwordHash: "sso-only", mustChangePassword: false, enabled: true });
  }
  writeUsers(users);
}

reconcileCoreUsers();

function seedJson(filePath, value) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readJson(filePath, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

seedJson(campaignsPath, [{ id: "default", name: "Travel Empire Advisor Campaign", status: "draft", script: "Default advisor script", leadCount: 0 }]);
seedJson(dispositionsPath, defaultDispositions);
seedJson(fieldMappingsPath, []);
seedJson(layoutPath, defaultLayout);
seedJson(leadsPath, []);
seedJson(leadListsPath, []);
seedJson(dncPath, []);
seedJson(leadFiltersPath, []);
seedJson(customLeadFieldsPath, []);

const seededLayout = readJson(layoutPath, defaultLayout);
if (Number(seededLayout.layoutVersion || 0) < 2) {
  const currentOrder = Array.isArray(seededLayout.sectionOrder) ? seededLayout.sectionOrder : defaultLayout.sectionOrder;
  const remaining = currentOrder.filter((section) => section !== "dispositions" && section !== "phone");
  seededLayout.sectionOrder = ["phone", "dispositions", ...remaining];
  seededLayout.layoutVersion = 2;
  writeJson(layoutPath, seededLayout);
}

const seededCampaigns = readJson(campaignsPath, []);
if (seededCampaigns.length && !seededCampaigns[0].scriptTemplate) {
  seededCampaigns[0].scriptTemplate = "Opening: Hi {{first_name}}, this is {{advisor_name}} with Travel Empire. I’m calling because we have a vacation collection selected for you.\n\nDiscovery: {{first_name}}, when you travel, what destination or experience creates the most value for you?\n\nQualification: Confirm citizenship, age, household income, and marital or cohabitation status before presenting the qualifying package.";
  seededCampaigns[0].status = "active";
  writeJson(campaignsPath, seededCampaigns);
}

let campaignAccessMigrated = false;
for (const campaign of seededCampaigns) {
  if (!Array.isArray(campaign.advisorExtensions)) {
    campaign.advisorExtensions = [];
    campaignAccessMigrated = true;
  }
  if (campaign.openEnrollment === undefined) {
    campaign.openEnrollment = true;
    campaignAccessMigrated = true;
  }
}
if (campaignAccessMigrated) writeJson(campaignsPath, seededCampaigns);

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", `wss://${publicHost}`],
      mediaSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use((request, response, next) => {
  response.setHeader("Permissions-Policy", "microphone=(self), camera=()");
  next();
});
app.use(express.json({ limit: "50mb" }));
app.use(session({
  name: "te_dialer_session",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000,
  },
}));
app.use((request, response, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return next();
  const origin = request.get("origin");
  if (origin && origin !== `https://${publicHost}`) return response.status(403).json({ error: "Invalid request origin" });
  next();
});

const loginAttempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  loginAttempts.set(ip, recent);
  return recent.length < 10;
}
function recordLoginFailure(ip) {
  loginAttempts.set(ip, [...(loginAttempts.get(ip) || []), Date.now()]);
}

function safeUser(user) {
  return {
    username: user.username,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
    extension: user.extension,
    mustChangePassword: user.mustChangePassword,
  };
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || "") || !/^[a-f0-9]{64}$/i.test(right || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function findOrCreateSsoUser(payload) {
  const email = String(payload.email || "").trim().toLowerCase();
  const users = readUsers();
  let user = payload.isAdmin ? users.find((candidate) => candidate.role === "admin") : users.find((candidate) => candidate.email === email || candidate.username === payload.username);
  if (!user) {
    const assigned = new Set(users.map((candidate) => candidate.extension).filter(Boolean));
    const extension = ["1001", "1002", "1003", "1004"].find((candidate) => !assigned.has(candidate)) || null;
    user = {
      username: String(payload.username || email.split("@")[0]).toLowerCase(),
      email,
      role: payload.isAdmin ? "admin" : "advisor",
      displayName: String(payload.displayName || email.split("@")[0]).slice(0, 80),
      extension,
      passwordHash: "sso-only",
      mustChangePassword: false,
      enabled: true,
    };
    users.push(user);
  } else {
    user.email = email;
    user.displayName = String(payload.displayName || user.displayName).slice(0, 80);
    user.role = payload.isAdmin ? "admin" : user.role;
    user.mustChangePassword = false;
  }
  writeUsers(users);
  return user;
}

function requireAuth(request, response, next) {
  if (!request.session.user) return response.status(401).json({ error: "Authentication required" });
  next();
}

function requireAdmin(request, response, next) {
  if (request.session.user?.role !== "admin" || request.session.user?.username !== "admin" || request.session.user?.extension !== "1003") return response.status(403).json({ error: "Administrator access required" });
  next();
}

function readAdvisorMessages() {
  try { return readJson(advisorMessagesPath, []); }
  catch { return []; }
}

function writeAdvisorMessages(messages) {
  writeJson(advisorMessagesPath, messages.slice(-5000));
}

function messagePeople(currentUsername) {
  const now = Date.now();
  return readUsers()
    .filter((user) => user.enabled !== false && user.extension && ["advisor", "admin"].includes(user.role) && user.username !== currentUsername)
    .map((user) => ({
      username: user.username, displayName: user.displayName, extension: user.extension, role: user.role,
      online: now - Number(advisorPresence.get(user.username) || 0) < 15000,
    }));
}

app.get("/api/messages", requireAuth, (request, response) => {
  const username = request.session.user.username;
  advisorPresence.set(username, Date.now());
  const selected = String(request.query.with || "").trim();
  const all = readAdvisorMessages();
  const visible = all.filter((message) => message.to === "*" || message.from === username || message.to === username);
  const messages = selected
    ? visible.filter((message) => selected === "announcements" ? message.to === "*" : (message.from === username && message.to === selected) || (message.from === selected && message.to === username)).slice(-100)
    : [];
  const unread = {};
  for (const message of visible) {
    if (message.from === username || (message.readBy || []).includes(username)) continue;
    const key = message.to === "*" ? "announcements" : message.from;
    unread[key] = Number(unread[key] || 0) + 1;
  }
  response.json({ people: messagePeople(username), messages, unread, canBroadcast: request.session.user.role === "admin" });
});

app.post("/api/messages", requireAuth, (request, response) => {
  const from = request.session.user.username;
  const to = String(request.body.to || "").trim();
  const body = String(request.body.body || "").trim().slice(0, 1200);
  if (!body) return response.status(400).json({ error: "Enter a message" });
  if (to === "*" && request.session.user.role !== "admin") return response.status(403).json({ error: "Only an administrator can send an announcement" });
  if (to !== "*" && !readUsers().some((user) => user.username === to && user.enabled !== false && user.extension)) return response.status(404).json({ error: "Advisor not found" });
  const messages = readAdvisorMessages();
  const message = { id: crypto.randomUUID(), from, fromName: request.session.user.displayName, to, body, createdAt: new Date().toISOString(), readBy: [from] };
  messages.push(message); writeAdvisorMessages(messages);
  response.status(201).json({ message });
});

app.post("/api/messages/read", requireAuth, (request, response) => {
  const username = request.session.user.username;
  const selected = String(request.body.with || "").trim();
  const messages = readAdvisorMessages();
  let changed = false;
  for (const message of messages) {
    const belongs = message.to === "*" || (message.from === selected && message.to === username);
    if (!belongs || message.from === username || (message.readBy || []).includes(username)) continue;
    message.readBy = [...(message.readBy || []), username]; changed = true;
  }
  if (changed) writeAdvisorMessages(messages);
  response.json({ ok: true });
});

app.post("/api/login", async (request, response) => {
  response.status(410).json({ error: "Use EmpireInsights single sign-on" });
});

app.get("/auth/sso", (request, response) => {
  try {
    const token = String(request.query.token || "");
    const signature = String(request.query.sig || "");
    const expected = crypto.createHmac("sha256", ssoSecret).update(token).digest("hex");
    if (!timingSafeHexEqual(signature, expected)) return response.status(403).send("Invalid EmpireInsights sign-on signature");
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now || payload.exp > now + 120) return response.status(403).send("EmpireInsights sign-on link expired");
    const user = findOrCreateSsoUser(payload);
    const resolvedEmail = String(user.email || "").trim().toLowerCase();
    const resolvedName = String(user.displayName || "").trim().toLowerCase();
    if (resolvedEmail === "dave@travelempire.org" || resolvedName === "dave sterling") Object.assign(user, { username: "dave", email: "dave@travelempire.org", role: "advisor", displayName: "Dave Sterling", extension: "1001" });
    if (resolvedEmail === "nick@travelempire.org" || resolvedName === "nick zurko") Object.assign(user, { username: "nick", email: "nick@travelempire.org", role: "advisor", displayName: "Nick Zurko", extension: "1002" });
    if (resolvedEmail === "be.theengine@gmail.com" || resolvedName === "jake adams") Object.assign(user, { username: "admin", email: "be.theengine@gmail.com", role: "admin", displayName: "Jake Adams", extension: "1003" });
    const launchView = user.role === "admin" && payload.view === "advisor" ? "advisor" : "admin";
    request.session.regenerate((error) => {
      if (error) return response.status(500).send("Unable to create EmpireConnection session");
      request.session.user = safeUser(user);
      response.redirect(launchView === "advisor" ? "/?view=advisor" : "/");
    });
  } catch {
    response.status(400).send("Invalid EmpireInsights sign-on request");
  }
});

app.post("/api/logout", requireAuth, (request, response) => {
  request.session.destroy(() => response.json({ ok: true }));
});

app.get("/api/me", requireAuth, (request, response) => response.json({ user: request.session.user }));
app.get("/api/calls/history", requireAuth, (request, response) => {
  const calls = loadCallHistory(
  activityPath,
  leadsPath,
  request.session.user.username
);

  response.json({ calls });
});
app.get("/api/campaigns", requireAuth, (request, response) => {
  const extension = String(request.session.user.extension || "");
  const campaigns = readJson(campaignsPath, []).map((campaign) => {
    const advisorExtensions = Array.isArray(campaign.advisorExtensions) ? campaign.advisorExtensions.map(String) : [];
    return {
      ...campaign,
      advisorExtensions,
      joined: Boolean(extension && advisorExtensions.includes(extension)),
      canJoin: Boolean(extension && campaign.status === "active" && campaign.openEnrollment !== false),
      memberCount: advisorExtensions.length,
    };
  });
  response.json({ campaigns });
});

app.post("/api/campaigns/:id/:operation", requireAuth, (request, response) => {
  const user = request.session.user;
  const extension = String(user.extension || "");
  const { id, operation } = request.params;
  if (!extension || !["advisor", "admin"].includes(user.role)) return response.status(403).json({ error: "An advisor phone extension is required" });
  if (!["join", "leave"].includes(operation)) return response.status(400).json({ error: "Choose join or leave" });
  const campaigns = readJson(campaignsPath, []);
  const campaign = campaigns.find((item) => item.id === id);
  if (!campaign || campaign.status !== "active") return response.status(404).json({ error: "That campaign is not active" });
  if (operation === "join" && campaign.openEnrollment === false && user.role !== "admin") return response.status(403).json({ error: "That campaign requires administrator assignment" });
  const members = new Set((Array.isArray(campaign.advisorExtensions) ? campaign.advisorExtensions : []).map(String));
  if (operation === "join") members.add(extension);
  else members.delete(extension);
  campaign.advisorExtensions = [...members].sort();
  campaign.updatedAt = new Date().toISOString();
  writeJson(campaignsPath, campaigns);
  fs.appendFileSync(activityPath, `${JSON.stringify({ at: campaign.updatedAt, user: user.username, type: `campaign_${operation}`, campaignId: campaign.id, extension })}\n`, { mode: 0o600 });
  response.json({ ok: true, campaign: { ...campaign, joined: operation === "join", canJoin: campaign.openEnrollment !== false, memberCount: campaign.advisorExtensions.length } });
});
app.get("/api/dispositions", requireAuth, (_request, response) => response.json({ dispositions: JSON.parse(fs.readFileSync(dispositionsPath, "utf8")) }));
app.get("/api/performance", requireAuth, (request, response) => {
  const username = request.session.user.username;
  const activity = fs.existsSync(activityPath)
    ? fs.readFileSync(activityPath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter((item) => item.user === username)
    : [];
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  weekStartDate.setDate(weekStartDate.getDate() - ((weekStartDate.getDay() + 6) % 7));
  const weekStart = weekStartDate.getTime();
  const commissionValue = (lead) => {
    const raw = lead.commissionAmount ?? lead.custom?.["Commission amount"] ?? lead.custom?.Commission ?? 0;
    const amount = Number(String(raw).replace(/[$,]/g, ""));
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  };
  const sales = readJson(leadsPath, []).filter((lead) => lead.status === "sale" && lead.lastAdvisor === username);
  const commissions = sales.reduce((totals, lead) => {
    const amount = commissionValue(lead);
    const soldAt = new Date(lead.lastContactAt || lead.updatedAt || 0).getTime();
    totals.all += amount;
    if (soldAt >= weekStart) totals.week += amount;
    if (soldAt >= todayStart) totals.today += amount;
    return totals;
  }, { today: 0, week: 0, all: 0 });
  const calls = activity.filter((item) => item.type === "call_started");
  const connections = activity.filter((item) => item.type === "call_connected");
  const ended = activity.filter((item) => item.type === "call_ended");
  response.json({
    dials: calls.length,
    connections: connections.length,
    talkSeconds: ended.reduce((sum, item) => sum + Math.max(0, Number(item.durationSeconds || 0)), 0),
    commissions,
  });
});

function pacificDayKey(value) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

app.get("/api/admin/advisor-wait-times", requireAuth, requireAdmin, (_request, response) => {
  const now = Date.now();
  const today = pacificDayKey(now);
  const activity = readActivity().filter((item) => Number.isFinite(new Date(item.at).getTime())).sort((left, right) => new Date(left.at) - new Date(right.at));
  const people = readUsers().filter((user) => user.extension && ["advisor", "admin"].includes(user.role));
  const advisors = people.map((user) => {
    const allEvents = activity.filter((item) => item.user === user.username);
    const events = allEvents.filter((item) => pacificDayKey(item.at) === today);
    const connected = events.filter((item) => item.type === "call_connected");
    const ended = events.filter((item) => item.type === "call_ended");
    const waits = [];
    let previousEnd = null;
    for (const event of events) {
      const time = new Date(event.at).getTime();
      if (event.type === "call_ended") previousEnd = time;
      if (event.type === "call_connected" && previousEnd !== null && time >= previousEnd) { waits.push(Math.round((time - previousEnd) / 1000)); previousEnd = null; }
    }
    const latestConnected = [...allEvents].reverse().find((item) => item.type === "call_connected");
    const latestEnded = [...allEvents].reverse().find((item) => item.type === "call_ended");
    const latestStatus = [...allEvents].reverse().find((item) => item.type === "status");
    const todayShift = [...events].reverse().find((item) => item.type === "shift_start");
    const connectedAt = latestConnected ? new Date(latestConnected.at).getTime() : 0;
    const endedAt = latestEnded ? new Date(latestEnded.at).getTime() : 0;
    const onCall = connectedAt > endedAt;
    let waitStartedAt = null;
    if (!onCall && latestEnded && pacificDayKey(latestEnded.at) === today) waitStartedAt = latestEnded.at;
    else if (!onCall && todayShift) waitStartedAt = todayShift.at;
    const currentWaitSeconds = waitStartedAt ? Math.max(0, Math.round((now - new Date(waitStartedAt).getTime()) / 1000)) : null;
    return {
      username: user.username, displayName: user.displayName, extension: user.extension, role: user.role,
      status: onCall ? "On Call" : String(latestStatus?.status || (waitStartedAt ? "Ready" : "Offline")), onCall,
      callsToday: connected.length, talkSeconds: ended.reduce((sum, item) => sum + Math.max(0, Number(item.durationSeconds || 0)), 0),
      currentWaitSeconds, waitStartedAt, averageWaitSeconds: waits.length ? Math.round(waits.reduce((sum, value) => sum + value, 0) / waits.length) : null,
      longestWaitSeconds: waits.length ? Math.max(...waits) : null, completedWaits: waits.length, lastCallEndedAt: latestEnded?.at || null,
    };
  }).sort((left, right) => (left.role === right.role ? left.displayName.localeCompare(right.displayName) : left.role === "advisor" ? -1 : 1));
  response.json({ generatedAt: new Date(now).toISOString(), timeZone: "America/Los_Angeles", advisors });
});

app.get("/api/layout", requireAuth, (_request, response) => {
  const customOptions = readJson(customLeadFieldsPath, []).map((field) => {
    const name = String(field.name || field);
    return { id: `custom:${name}`, label: name };
  });
  response.json({ layout: readJson(layoutPath, defaultLayout), customerFieldOptions: [...customerFieldOptions, ...customOptions], fixedCustomerFields });
});

app.put("/api/admin/layout", requireAuth, requireAdmin, (request, response) => {
  const customOptions = readJson(customLeadFieldsPath, []).map((field) => `custom:${String(field.name || field)}`);
  const allowedCustomerFields = new Set([...customerFieldOptions.map((field) => field.id), ...customOptions]);
  const allowedSections = new Set(defaultLayout.sectionOrder);
  const customerFields = [...new Set((Array.isArray(request.body.customerFields) ? request.body.customerFields : []).map(String))];
  const sectionOrder = (Array.isArray(request.body.sectionOrder) ? request.body.sectionOrder : []).map(String);
  const tones = new Set(["not-interested", "dnc", "callback", "no-answer", "email", "voicemail", "language", "success"]);
  const dispositions = (Array.isArray(request.body.dispositions) ? request.body.dispositions : []).map((item, index) => ({
    id: String(item.id || `custom-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 48),
    label: String(item.label || "").trim().slice(0, 40),
    action: String(item.action || "complete").trim().slice(0, 40),
    tone: tones.has(item.tone) ? item.tone : "not-interested",
  })).filter((item) => item.id && item.label);
  if (customerFields.length !== 3 || customerFields.some((field) => !allowedCustomerFields.has(field))) return response.status(400).json({ error: "Choose exactly three valid customer fields" });
  if (dispositions.length < 2 || dispositions.length > 20 || new Set(dispositions.map((item) => item.id)).size !== dispositions.length) return response.status(400).json({ error: "Use between 2 and 20 uniquely named dispositions" });
  if (sectionOrder.length !== allowedSections.size || new Set(sectionOrder).size !== allowedSections.size || sectionOrder.some((section) => !allowedSections.has(section))) return response.status(400).json({ error: "The workspace layout is incomplete" });
  const layout = { layoutVersion: 2, dispositions, customerFields, fixedCustomerFields, sectionOrder };
  writeJson(layoutPath, layout);
  writeJson(dispositionsPath, dispositions);
  response.json({ ok: true, layout });
});

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return /^[2-9][0-9]{9}$/.test(digits) ? `1${digits}` : "";
}

function normalizeZip(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 4) digits = digits.padStart(5, "0");
  if (digits.length === 8) digits = digits.padStart(9, "0");
  return [5, 9].includes(digits.length) ? digits : "";
}

const zipStateExceptions = new Map([
  ["75502", "AR"], ["45275", "KY"], ["71749", "LA"], ["03801", "ME"], ["20331", "MD"],
  ["06390", "NY"], ["73949", "TX"], ["20041", "VA"], ["20370", "VA"], ["20301", "VA"], ["49936", "WI"],
]);

const zipStateRanges = [
  ["NY", [[5, 5], [63, 63], [100, 149]]], ["PR", [[6, 9]]], ["VI", [[8, 8]]], ["MA", [[10, 27], [55, 55]]],
  ["RI", [[28, 29]]], ["NH", [[30, 38]]], ["ME", [[39, 49]]], ["VT", [[50, 54], [56, 59]]],
  ["CT", [[60, 69]]], ["NJ", [[70, 89]]], ["AE", [[90, 98]]], ["PA", [[150, 196]]], ["DE", [[197, 199]]],
  ["DC", [[200, 200], [202, 205]]], ["VA", [[201, 201], [220, 246]]], ["MD", [[206, 212], [214, 219]]],
  ["WV", [[247, 268]]], ["NC", [[270, 289]]], ["SC", [[290, 299]]], ["GA", [[300, 319], [398, 399]]],
  ["FL", [[320, 342], [344, 344], [346, 347], [349, 349]]], ["AA", [[340, 340]]],
  ["AL", [[350, 352], [354, 369]]], ["TN", [[370, 385]]], ["MS", [[386, 397]]], ["KY", [[400, 427]]],
  ["OH", [[430, 459]]], ["IN", [[460, 479]]], ["MI", [[480, 499]]], ["IA", [[500, 516], [520, 528]]],
  ["WI", [[530, 532], [534, 535], [537, 549]]], ["MN", [[550, 551], [553, 567]]], ["SD", [[570, 577]]],
  ["ND", [[580, 588]]], ["MT", [[590, 599]]], ["IL", [[600, 620], [622, 629]]],
  ["MO", [[630, 631], [633, 641], [644, 658]]], ["KS", [[660, 662], [664, 679]]],
  ["NE", [[680, 681], [683, 693]]], ["LA", [[700, 701], [703, 708], [710, 714]]], ["AR", [[716, 729]]],
  ["OK", [[730, 731], [734, 741], [743, 749]]], ["TX", [[733, 733], [739, 739], [750, 770], [772, 779], [885, 885]]],
  ["CO", [[800, 816]]], ["WY", [[820, 831], [834, 834]]], ["ID", [[832, 838]]], ["UT", [[840, 847]]],
  ["AZ", [[850, 853], [855, 857], [859, 860], [863, 865]]], ["NM", [[870, 871], [873, 876], [877, 884]]],
  ["NV", [[889, 891], [893, 895], [897, 898]]], ["CA", [[900, 928], [930, 961]]], ["AP", [[962, 966]]],
  ["HI", [[967, 968]]], ["OR", [[970, 979]]], ["WA", [[980, 986], [988, 994]]], ["AK", [[995, 999]]],
];

function stateFromZip(value) {
  const zip = normalizeZip(value).slice(0, 5);
  if (!zip) return "";
  if (zipStateExceptions.has(zip)) return zipStateExceptions.get(zip);
  if (zip === "96799") return "AS";
  const prefix = Number(zip.slice(0, 3));
  return zipStateRanges.find(([, ranges]) => ranges.some(([start, end]) => prefix >= start && prefix <= end))?.[0] || "";
}

function normalizeCountry(value) {
  const country = String(value || "").trim();
  if (/^(us|usa|u\.s\.?a?\.?|united states(?: of america)?)$/i.test(country)) return "United States";
  if (/^canada$/i.test(country)) return "Canada";
  return country.replace(/\s+/g, " ");
}

function cleanPersonName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || !/^[A-Z' -]+$/.test(name)) return name;
  return name.toLowerCase().replace(/(^|[ '\-])([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`).replace(/\bMc([a-z])/g, (_match, letter) => `Mc${letter.toUpperCase()}`);
}

function readActivity() {
  if (!fs.existsSync(activityPath)) return [];
  return fs.readFileSync(activityPath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function leadCallMetrics(activity = readActivity()) {
  const metrics = new Map();
  for (const item of activity) {
    if (!item.leadId || !["call_started", "call_connected", "call_ended"].includes(item.type)) continue;
    const current = metrics.get(item.leadId) || { dials: 0, connections: 0, talkSeconds: 0, maxTalkSeconds: 0, lastCallAt: null };
    if (item.type === "call_started") current.dials += 1;
    if (item.type === "call_connected") current.connections += 1;
    if (item.type === "call_ended") {
      const duration = Math.max(0, Number(item.durationSeconds || 0));
      current.talkSeconds += duration;
      current.maxTalkSeconds = Math.max(current.maxTalkSeconds, duration);
    }
    if (!current.lastCallAt || new Date(item.at).getTime() > new Date(current.lastCallAt).getTime()) current.lastCallAt = item.at;
    metrics.set(item.leadId, current);
  }
  return metrics;
}

const leadFilterFields = new Set(["state", "country", "status", "disposition", "advisor", "campaign", "list", "source", "priorDestination", "attempts", "talkSeconds", "maxTalkSeconds", "createdAt", "lastContactAt", "archived"]);
const leadFilterOperators = new Set(["equals", "not_equals", "contains", "not_contains", "in", "not_in", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "before", "after", "is_blank", "not_blank"]);

function sanitizeLeadRules(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((rule) => ({
    field: String(rule.field || ""), operator: String(rule.operator || "equals"), value: String(rule.value ?? "").trim().slice(0, 300),
  })).filter((rule) => leadFilterFields.has(rule.field) && leadFilterOperators.has(rule.operator));
}

function leadFilterValue(lead, field, context) {
  const list = context.lists.find((item) => item.id === lead.listId);
  const campaign = context.campaigns.find((item) => item.id === lead.campaignId);
  const metric = context.metrics.get(lead.id) || {};
  const values = {
    state: lead.state, country: lead.country, status: lead.status, disposition: lead.dispositionLabel || lead.dispositionId,
    advisor: lead.assignedExtension || lead.lastAdvisor, campaign: campaign?.name || lead.campaignId, list: list?.name || lead.listId,
    source: lead.source, priorDestination: lead.priorDestination, attempts: Number(lead.attempts || 0),
    talkSeconds: Number(metric.talkSeconds || 0), maxTalkSeconds: Number(metric.maxTalkSeconds || 0),
    createdAt: lead.createdAt, lastContactAt: lead.lastContactAt, archived: Boolean(lead.archived),
  };
  return values[field];
}

function matchesLeadRule(lead, rule, context) {
  const raw = leadFilterValue(lead, rule.field, context);
  if (rule.operator === "is_blank") return raw === undefined || raw === null || raw === "";
  if (rule.operator === "not_blank") return raw !== undefined && raw !== null && raw !== "";
  if (["attempts", "talkSeconds", "maxTalkSeconds"].includes(rule.field)) {
    const left = Number(raw || 0); const right = Number(rule.value || 0);
    if (rule.operator === "greater_than") return left > right;
    if (rule.operator === "greater_or_equal") return left >= right;
    if (rule.operator === "less_than") return left < right;
    if (rule.operator === "less_or_equal") return left <= right;
    if (rule.operator === "not_equals") return left !== right;
    return left === right;
  }
  if (["createdAt", "lastContactAt"].includes(rule.field) && ["before", "after"].includes(rule.operator)) {
    const left = new Date(raw || 0).getTime(); const right = new Date(rule.value).getTime();
    return Number.isFinite(left) && Number.isFinite(right) && (rule.operator === "before" ? left < right : left > right);
  }
  const left = String(raw ?? "").trim().toLowerCase();
  const right = String(rule.value ?? "").trim().toLowerCase();
  const choices = right.split(",").map((item) => item.trim()).filter(Boolean);
  if (rule.operator === "contains") return left.includes(right);
  if (rule.operator === "not_contains") return !left.includes(right);
  if (rule.operator === "in") return choices.includes(left);
  if (rule.operator === "not_in") return !choices.includes(left);
  if (rule.operator === "not_equals") return left !== right;
  return left === right;
}

function matchesLeadRules(lead, rules, match, context) {
  if (!rules.length) return true;
  return match === "any" ? rules.some((rule) => matchesLeadRule(lead, rule, context)) : rules.every((rule) => matchesLeadRule(lead, rule, context));
}

function passesSavedDialingFilters(lead, filters, context) {
  return filters.every((filter) => {
    const matched = matchesLeadRules(lead, filter.rules || [], filter.match, context);
    return filter.mode === "include" ? matched : !matched;
  });
}

function leadName(lead) {
  return String(lead.fullName || `${lead.firstName || ""} ${lead.lastName || ""}`).trim();
}

function publicLead(lead, lists = readJson(leadListsPath, []), campaigns = readJson(campaignsPath, [])) {
  const list = lists.find((item) => item.id === lead.listId);
  const campaign = campaigns.find((item) => item.id === lead.campaignId);
  return {
    ...lead,
    fullName: leadName(lead),
    listName: list?.name || "Unassigned list",
    campaignName: campaign?.name || "Unassigned",
    scriptTemplate: campaign?.scriptTemplate || "",
  };
}

function empireInsightsSaleUrl(lead) {
  const url = new URL("https://crm.travelempire.org/wp-admin/admin.php");
  url.searchParams.set("page", "tecrm-new-sale");
  url.searchParams.set("source", "empireconnections");
  const fullNameParts = String(lead.fullName || "").trim().split(/\s+/).filter(Boolean);
  const firstName = String(lead.firstName || fullNameParts[0] || "").trim();
  const lastName = String(lead.lastName || fullNameParts.slice(1).join(" ") || "").trim();
  const customerFields = {
    first_name: firstName,
    last_name: lastName,
    email: lead.email,
    phone: lead.phone,
    alternate_phone: lead.alternatePhone,
    address: lead.address,
    city: lead.city,
    state: lead.state,
    zip: lead.zip,
  };
  for (const [field, value] of Object.entries(customerFields)) {
    const normalized = String(value || "").trim();
    if (normalized) url.searchParams.set(field, normalized);
  }
  return url.toString();
}

function fieldKey(destination) {
  const keys = {
    "First name": "firstName", "Last name": "lastName", "Full name": "fullName", Phone: "phone",
    "Alternate phone": "alternatePhone", Email: "email", Address: "address", City: "city", State: "state",
    ZIP: "zip", Country: "country", "Time zone": "timeZone", "Lead ID": "externalId", "Campaign notes": "campaignNotes",
    "Loyalty program": "loyaltyProgram", "Loyalty tier": "loyaltyTier", "Preferred destination": "preferredDestination",
    "Prior destination": "priorDestination", Language: "language", Source: "source", "Commission amount": "commissionAmount", "Last purchase": "lastPurchaseAt",
  };
  return keys[destination] || (destination.startsWith("Custom: ") ? `custom:${destination.slice(8)}` : "");
}

function mapImportedLead(row, headers, fields) {
  const lead = { custom: {} };
  for (const field of fields) {
    const sourceIndex = headers.indexOf(field.source);
    if (sourceIndex < 0) continue;
    const key = fieldKey(field.destination);
    const value = String(row[sourceIndex] || "").trim().slice(0, key === "campaignNotes" ? 2000 : 300);
    if (key.startsWith("custom:")) lead.custom[key.slice(7)] = value;
    else if (key) lead[key] = value;
  }
  lead.phone = normalizePhone(lead.phone);
  lead.alternatePhone = normalizePhone(lead.alternatePhone);
  lead.firstName = cleanPersonName(lead.firstName);
  lead.lastName = cleanPersonName(lead.lastName);
  lead.email = /^\S+@\S+\.\S+$/.test(String(lead.email || "").toLowerCase()) ? String(lead.email).toLowerCase() : "";
  lead.zip = normalizeZip(lead.zip);
  lead.country = normalizeCountry(lead.country) || "United States";
  lead.state = String(lead.state || stateFromZip(lead.zip)).trim().toUpperCase().slice(0, 3);
  if (lead.lastPurchaseAt) {
    const shortDate = String(lead.lastPurchaseAt).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    const parsed = shortDate ? new Date(Date.UTC(2000 + Number(shortDate[3]), Number(shortDate[1]) - 1, Number(shortDate[2]))) : new Date(lead.lastPurchaseAt);
    if (Number.isFinite(parsed.getTime())) lead.lastPurchaseAt = parsed.toISOString().slice(0, 10);
  }
  if (!lead.fullName) lead.fullName = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();
  else lead.fullName = cleanPersonName(lead.fullName);
  return lead;
}

app.post("/api/admin/campaigns", requireAuth, requireAdmin, (request, response) => {
  const name = String(request.body.name || "").trim().slice(0, 100);
  if (name.length < 2) return response.status(400).json({ error: "Enter a campaign name" });
  const campaigns = readJson(campaignsPath, []);
  const campaign = {
    id: crypto.randomUUID(), name, status: "active", leadCount: 0,
    openEnrollment: true,
    advisorExtensions: [...new Set([
      ...(Array.isArray(request.body.advisorExtensions) ? request.body.advisorExtensions : []),
      request.session.user.extension,
    ].map(String).filter((item) => /^100[1-4]$/.test(item)))],
    scriptTemplate: String(request.body.scriptTemplate || "Opening: Hi {{first_name}}, this is {{advisor_name}} with Travel Empire.").slice(0, 12000),
    createdAt: new Date().toISOString(),
  };
  campaigns.push(campaign);
  writeJson(campaignsPath, campaigns);
  response.status(201).json({ campaign });
});

app.get("/api/admin/lead-lists", requireAuth, requireAdmin, (_request, response) => {
  const lists = readJson(leadListsPath, []);
  const leads = readJson(leadsPath, []);
  const campaigns = readJson(campaignsPath, []);
  const users = readUsers().filter((user) => user.extension && ["advisor", "admin"].includes(user.role)).map(safeUser);
  response.json({
    campaigns,
    users,
    lists: lists.map((list) => {
      const records = leads.filter((lead) => lead.listId === list.id);
      return {
        ...list,
        total: records.length,
        available: records.filter((lead) => ["new", "retry"].includes(lead.status)).length,
        completed: records.filter((lead) => ["complete", "sale", "suppressed"].includes(lead.status)).length,
      };
    }),
  });
});

app.post("/api/admin/lead-lists/import", requireAuth, requireAdmin, (request, response) => {
  const name = String(request.body.name || "").trim().slice(0, 100);
  const campaignId = String(request.body.campaignId || "default");
  const headers = (Array.isArray(request.body.headers) ? request.body.headers : []).map((item) => String(item).trim().slice(0, 120));
  const rows = Array.isArray(request.body.rows) ? request.body.rows.slice(0, 50000) : [];
  const fields = Array.isArray(request.body.fields) ? request.body.fields : [];
  const campaigns = readJson(campaignsPath, []);
  if (request.body.mappingVerified !== true) return response.status(400).json({ error: "Verify the CSV field mapping before importing" });
  if (name.length < 2) return response.status(400).json({ error: "Enter a lead-list name" });
  if (!campaigns.some((campaign) => campaign.id === campaignId)) return response.status(400).json({ error: "Choose a valid campaign" });
  if (!headers.length || !rows.length || !fields.some((field) => field.destination === "Phone")) return response.status(400).json({ error: "Upload a CSV and map its Phone column" });
  const normalizedFields = fields.map((field) => ({
    source: String(field.source || "").trim().slice(0, 120),
    destination: String(field.destination || "").trim().slice(0, 80),
    required: Boolean(field.required),
  })).filter((field) => field.source && field.destination && field.destination !== "Ignore column");
  if (normalizedFields.some((field) => !headers.includes(field.source))) return response.status(400).json({ error: "One or more mapped CSV columns are missing" });
  if (new Set(normalizedFields.map((field) => field.destination.toLowerCase())).size !== normalizedFields.length) return response.status(400).json({ error: "Each EmpireConnections field may be mapped only once" });
  const customLeadFields = readJson(customLeadFieldsPath, []);
  const validCustomFields = new Set(customLeadFields.map((field) => String(field.name || field).toLowerCase()));
  for (const field of normalizedFields) {
    if (field.destination.startsWith("Custom: ") && !validCustomFields.has(field.destination.slice(8).trim().toLowerCase())) {
      return response.status(400).json({ error: `Create the custom field “${field.destination.slice(8)}” before importing` });
    }
  }
  const kind = request.body.kind === "supplemental" ? "supplemental" : "primary";
  const blendPercent = Math.min(100, Math.max(0, Number(request.body.blendPercent || (kind === "supplemental" ? 20 : 100))));
  const assignedExtensions = [...new Set((Array.isArray(request.body.assignedExtensions) ? request.body.assignedExtensions : []).map(String).filter((item) => /^100[1-4]$/.test(item)))];
  const assignmentMode = ["split", "shared", "assigned-pool"].includes(request.body.assignmentMode) ? request.body.assignmentMode : (request.body.shared ? "shared" : "assigned-pool");
  const shared = assignmentMode === "shared";
  if (!shared && !assignedExtensions.length) return response.status(400).json({ error: "Assign the list to at least one advisor or mark it shared" });
  if (assignmentMode === "split" && assignedExtensions.length < 2) return response.status(400).json({ error: "Choose at least two advisors for an even split" });
  const allLeads = readJson(leadsPath, []);
  const dnc = new Set(readJson(dncPath, []));
  const existingPhones = new Set(allLeads.map((lead) => lead.phone).filter(Boolean));
  const list = {
    id: crypto.randomUUID(), name, campaignId, kind, blendPercent, assignedExtensions, shared, assignmentMode,
    status: "active", retryMinutes: Math.min(10080, Math.max(15, Number(request.body.retryMinutes || 240))),
    createdAt: new Date().toISOString(), createdBy: request.session.user.username,
  };
  const stats = { imported: 0, duplicates: 0, invalid: 0, dnc: 0 };
  for (const row of rows) {
    const missingRequiredValue = normalizedFields.some((field) => field.required && !String(row[headers.indexOf(field.source)] || "").trim());
    if (missingRequiredValue) { stats.invalid += 1; continue; }
    const mapped = mapImportedLead(row, headers, normalizedFields);
    if (!mapped.phone || !leadName(mapped)) { stats.invalid += 1; continue; }
    if (dnc.has(mapped.phone)) { stats.dnc += 1; continue; }
    if (existingPhones.has(mapped.phone)) { stats.duplicates += 1; continue; }
    existingPhones.add(mapped.phone);
    const assignedExtension = assignmentMode === "split" ? assignedExtensions[stats.imported % assignedExtensions.length] : null;
    allLeads.push({
      id: crypto.randomUUID(), ...mapped, listId: list.id, campaignId, status: "new", attempts: 0,
      source: mapped.source || name, assignedExtension, archived: false, notes: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    stats.imported += 1;
  }
  if (!stats.imported) return response.status(400).json({ error: "No valid, unique, callable leads were found", stats });
  const lists = readJson(leadListsPath, []);
  lists.push(list);
  writeJson(leadListsPath, lists);
  writeJson(leadsPath, allLeads);
  const campaign = campaigns.find((item) => item.id === campaignId);
  campaign.leadCount = allLeads.filter((lead) => lead.campaignId === campaignId).length;
  writeJson(campaignsPath, campaigns);
  const byAdvisor = Object.fromEntries(assignedExtensions.map((extension) => [extension, allLeads.filter((lead) => lead.listId === list.id && lead.assignedExtension === extension).length]));
  response.status(201).json({ list, stats: { ...stats, byAdvisor } });
});

app.get("/api/admin/lead-fields", requireAuth, requireAdmin, (_request, response) => {
  response.json({ fields: readJson(customLeadFieldsPath, []) });
});

app.post("/api/admin/lead-fields", requireAuth, requireAdmin, (request, response) => {
  const name = String(request.body.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (name.length < 2) return response.status(400).json({ error: "Enter a field name" });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 /&().'-]*$/.test(name)) return response.status(400).json({ error: "Use letters, numbers, spaces, and ordinary punctuation in field names" });
  const fields = readJson(customLeadFieldsPath, []);
  const existing = fields.find((field) => String(field.name || field).toLowerCase() === name.toLowerCase());
  if (existing) return response.json({ field: existing, created: false });
  const field = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString(), createdBy: request.session.user.username };
  fields.push(field);
  writeJson(customLeadFieldsPath, fields);
  response.status(201).json({ field, created: true });
});

app.patch("/api/admin/lead-lists/:id", requireAuth, requireAdmin, (request, response) => {
  const lists = readJson(leadListsPath, []);
  const list = lists.find((item) => item.id === request.params.id);
  if (!list) return response.status(404).json({ error: "Lead list not found" });
  if (request.body.name !== undefined) list.name = String(request.body.name).trim().slice(0, 100) || list.name;
  if (["active", "paused", "archived"].includes(request.body.status)) list.status = request.body.status;
  if (["primary", "supplemental"].includes(request.body.kind)) list.kind = request.body.kind;
  if (request.body.blendPercent !== undefined) list.blendPercent = Math.min(100, Math.max(0, Number(request.body.blendPercent)));
  if (request.body.shared !== undefined) list.shared = Boolean(request.body.shared);
  if (Array.isArray(request.body.assignedExtensions)) list.assignedExtensions = [...new Set(request.body.assignedExtensions.map(String).filter((item) => /^100[1-4]$/.test(item)))];
  list.updatedAt = new Date().toISOString();
  writeJson(leadListsPath, lists);
  response.json({ ok: true, list });
});

function leadAdminContext() {
  return {
    lists: readJson(leadListsPath, []), campaigns: readJson(campaignsPath, []), metrics: leadCallMetrics(),
    users: readUsers().filter((user) => user.extension && ["advisor", "admin"].includes(user.role)).map(safeUser),
  };
}

function adminLeadRow(lead, context) {
  const metric = context.metrics.get(lead.id) || { dials: 0, connections: 0, talkSeconds: 0, maxTalkSeconds: 0, lastCallAt: null };
  const list = context.lists.find((item) => item.id === lead.listId);
  const campaign = context.campaigns.find((item) => item.id === lead.campaignId);
  const advisor = context.users.find((item) => item.extension === lead.assignedExtension) || context.users.find((item) => item.username === lead.lastAdvisor);
  return {
    ...lead, fullName: leadName(lead), listName: list?.name || "Unassigned", campaignName: campaign?.name || "Unassigned",
    advisorName: advisor?.displayName || lead.assignedExtension || lead.lastAdvisor || "Unassigned", ...metric,
  };
}

app.get("/api/admin/lead-filters", requireAuth, requireAdmin, (_request, response) => {
  response.json({ filters: readJson(leadFiltersPath, []) });
});

app.post("/api/admin/lead-filters", requireAuth, requireAdmin, (request, response) => {
  const name = String(request.body.name || "").trim().slice(0, 80);
  const rules = sanitizeLeadRules(request.body.rules);
  if (name.length < 2 || !rules.length) return response.status(400).json({ error: "Name the filter and add at least one valid rule" });
  const filters = readJson(leadFiltersPath, []);
  const filter = {
    id: crypto.randomUUID(), name, mode: request.body.mode === "include" ? "include" : "exclude",
    match: request.body.match === "any" ? "any" : "all", scope: request.body.scope === "view" ? "view" : "dialing",
    rules, enabled: request.body.enabled !== false, createdAt: new Date().toISOString(), createdBy: request.session.user.username,
  };
  filters.push(filter); writeJson(leadFiltersPath, filters); response.status(201).json({ filter });
});

app.patch("/api/admin/lead-filters/:id", requireAuth, requireAdmin, (request, response) => {
  const filters = readJson(leadFiltersPath, []); const filter = filters.find((item) => item.id === request.params.id);
  if (!filter) return response.status(404).json({ error: "Lead filter not found" });
  if (request.body.enabled !== undefined) filter.enabled = Boolean(request.body.enabled);
  if (request.body.name !== undefined) filter.name = String(request.body.name).trim().slice(0, 80) || filter.name;
  if (["include", "exclude"].includes(request.body.mode)) filter.mode = request.body.mode;
  if (["all", "any"].includes(request.body.match)) filter.match = request.body.match;
  if (["dialing", "view"].includes(request.body.scope)) filter.scope = request.body.scope;
  if (request.body.rules !== undefined) {
    const rules = sanitizeLeadRules(request.body.rules); if (!rules.length) return response.status(400).json({ error: "Add at least one valid rule" }); filter.rules = rules;
  }
  filter.updatedAt = new Date().toISOString(); writeJson(leadFiltersPath, filters); response.json({ ok: true, filter });
});

app.delete("/api/admin/lead-filters/:id", requireAuth, requireAdmin, (request, response) => {
  const filters = readJson(leadFiltersPath, []); const next = filters.filter((item) => item.id !== request.params.id);
  if (next.length === filters.length) return response.status(404).json({ error: "Lead filter not found" });
  writeJson(leadFiltersPath, next); response.json({ ok: true });
});

function filterAdminLeads(leads, payload, context) {
  const rules = sanitizeLeadRules(payload.rules);
  const match = payload.match === "any" ? "any" : "all";
  const mode = payload.mode === "exclude" ? "exclude" : "include";
  const search = String(payload.search || "").trim().toLowerCase();
  return leads.filter((lead) => {
    if (search) {
      const haystack = [leadName(lead), lead.phone, lead.email, lead.city, lead.state, lead.country, lead.source, lead.priorDestination, lead.dispositionLabel].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (!rules.length) return true;
    const matched = matchesLeadRules(lead, rules, match, context);
    return mode === "exclude" ? !matched : matched;
  });
}

app.post("/api/admin/leads/query", requireAuth, requireAdmin, (request, response) => {
  const leads = readJson(leadsPath, []); const context = leadAdminContext();
  const filtered = filterAdminLeads(leads, request.body || {}, context);
  const sort = ["createdAt", "lastContactAt", "talkSeconds", "fullName", "state", "status"].includes(request.body.sort) ? request.body.sort : "createdAt";
  const direction = request.body.direction === "asc" ? 1 : -1;
  const rows = filtered.map((lead) => adminLeadRow(lead, context)).sort((left, right) => {
    const a = left[sort] ?? ""; const b = right[sort] ?? ""; return (typeof a === "number" ? a - b : String(a).localeCompare(String(b))) * direction;
  });
  const page = Math.max(1, Number(request.body.page || 1)); const limit = Math.min(200, Math.max(25, Number(request.body.limit || 50)));
  const statuses = new Set(["new", "retry", "callback"]);
  const stats = {
    total: leads.length, callable: leads.filter((lead) => !lead.archived && statuses.has(lead.status)).length,
    called: leads.filter((lead) => Number(lead.attempts || 0) > 0).length,
    dnc: leads.filter((lead) => lead.status === "suppressed").length, archived: leads.filter((lead) => lead.archived).length,
    filtered: rows.length,
  };
  const unique = (values) => [...new Set(values.filter(Boolean).map(String))].sort();
  response.json({
    stats, page, limit, pages: Math.max(1, Math.ceil(rows.length / limit)), rows: rows.slice((page - 1) * limit, page * limit),
    facets: {
      states: unique(leads.map((lead) => lead.state)), countries: unique(leads.map((lead) => lead.country)),
      statuses: unique(leads.map((lead) => lead.status)), dispositions: unique(leads.map((lead) => lead.dispositionLabel || lead.dispositionId)),
      lists: context.lists.map((item) => ({ id: item.id, name: item.name })), campaigns: context.campaigns.map((item) => ({ id: item.id, name: item.name })), users: context.users,
    },
  });
});

app.post("/api/admin/leads/bulk", requireAuth, requireAdmin, (request, response) => {
  const ids = new Set((Array.isArray(request.body.ids) ? request.body.ids : []).map(String).slice(0, 5000));
  const action = String(request.body.action || "");
  if (!ids.size || !["archive", "restore", "dnc", "assign", "unassign"].includes(action)) return response.status(400).json({ error: "Choose leads and a valid bulk action" });
  const assignmentExtension = String(request.body.extension || "");
  if (action === "assign" && !/^100[1-4]$/.test(assignmentExtension)) return response.status(400).json({ error: "Choose a valid advisor" });
  const leads = readJson(leadsPath, []); const dnc = new Set(readJson(dncPath, [])); let changed = 0;
  for (const lead of leads) {
    if (!ids.has(lead.id)) continue;
    if (action === "archive") { lead.archived = true; lead.archivedAt = new Date().toISOString(); }
    if (action === "restore") { lead.archived = false; delete lead.archivedAt; }
    if (action === "dnc") { lead.status = "suppressed"; lead.archived = false; dnc.add(lead.phone); delete lead.reservedBy; delete lead.reservedAt; }
    if (action === "assign") lead.assignedExtension = assignmentExtension;
    if (action === "unassign") lead.assignedExtension = null;
    lead.updatedAt = new Date().toISOString(); changed += 1;
  }
  writeJson(leadsPath, leads); if (action === "dnc") writeJson(dncPath, [...dnc]); response.json({ ok: true, changed });
});

app.post("/api/admin/leads/create-list", requireAuth, requireAdmin, (request, response) => {
  const name = String(request.body.name || "").trim().slice(0, 100); const campaignId = String(request.body.campaignId || "default");
  const assignedExtensions = [...new Set((Array.isArray(request.body.assignedExtensions) ? request.body.assignedExtensions : []).map(String).filter((item) => /^100[1-4]$/.test(item)))];
  const assignmentMode = ["split", "shared", "assigned-pool"].includes(request.body.assignmentMode) ? request.body.assignmentMode : "assigned-pool";
  if (name.length < 2 || !assignedExtensions.length) return response.status(400).json({ error: "Name the list and choose at least one advisor" });
  if (assignmentMode === "split" && assignedExtensions.length < 2) return response.status(400).json({ error: "Choose at least two advisors for an even split" });
  const leads = readJson(leadsPath, []); const context = leadAdminContext(); const campaigns = context.campaigns;
  if (!campaigns.some((item) => item.id === campaignId)) return response.status(400).json({ error: "Choose a valid campaign" });
  const ids = new Set((Array.isArray(request.body.ids) ? request.body.ids : []).map(String));
  const candidates = (ids.size ? leads.filter((lead) => ids.has(lead.id)) : filterAdminLeads(leads, request.body.filter || {}, context))
    .filter((lead) => !["suppressed", "sale", "reserved"].includes(lead.status));
  if (!candidates.length) return response.status(400).json({ error: "No eligible leads matched this list" });
  const list = {
    id: crypto.randomUUID(), name, campaignId, kind: request.body.kind === "supplemental" ? "supplemental" : "primary",
    blendPercent: Math.min(100, Math.max(0, Number(request.body.blendPercent || 100))), assignedExtensions,
    shared: assignmentMode === "shared", assignmentMode, status: "active", retryMinutes: Math.min(10080, Math.max(15, Number(request.body.retryMinutes || 240))),
    createdAt: new Date().toISOString(), createdBy: request.session.user.username,
  };
  candidates.forEach((lead, index) => {
    lead.listId = list.id; lead.campaignId = campaignId; lead.status = "new"; lead.archived = false;
    lead.assignedExtension = assignmentMode === "split" ? assignedExtensions[index % assignedExtensions.length] : assignedExtensions.length === 1 ? assignedExtensions[0] : null;
    delete lead.archivedAt; delete lead.reservedBy; delete lead.reservedAt; lead.updatedAt = new Date().toISOString();
  });
  const lists = context.lists; lists.push(list); writeJson(leadListsPath, lists); writeJson(leadsPath, leads);
  const campaign = campaigns.find((item) => item.id === campaignId); campaign.leadCount = leads.filter((lead) => lead.campaignId === campaignId).length; writeJson(campaignsPath, campaigns);
  response.status(201).json({ list, assigned: candidates.length, byAdvisor: Object.fromEntries(assignedExtensions.map((extension) => [extension, candidates.filter((lead) => lead.assignedExtension === extension).length])) });
});

function leadIsEligible(lead, user, lists, campaigns, now, filters = [], context = null) {
  const list = lists.find((item) => item.id === lead.listId);
  const campaign = campaigns.find((item) => item.id === lead.campaignId);
  if (lead.archived || !list || list.status !== "active" || !campaign || campaign.status !== "active") return false;
  if (lead.assignedExtension && lead.assignedExtension !== user.extension) return false;
  if (!list.shared && !list.assignedExtensions.includes(user.extension)) return false;
  const campaignMembers = Array.isArray(campaign.advisorExtensions) ? campaign.advisorExtensions.map(String) : [];
  if (campaign.openEnrollment === true && !campaignMembers.includes(String(user.extension))) return false;
  if (campaign.openEnrollment !== true && campaignMembers.length && !campaignMembers.includes(String(user.extension))) return false;
  if (filters.length && context && !passesSavedDialingFilters(lead, filters, context)) return false;
  if (lead.status === "callback") return lead.callbackOwner === user.username && new Date(lead.callbackAt).getTime() <= now;
  if (lead.status === "retry") return !lead.availableAt || new Date(lead.availableAt).getTime() <= now;
  return lead.status === "new";
}

app.get("/api/leads/next", requireAuth, (request, response) => {
  const user = request.session.user;
  if (!user.extension) return response.status(403).json({ error: "No phone extension assigned" });
  const lists = readJson(leadListsPath, []);
  const campaigns = readJson(campaignsPath, []);
  const leads = readJson(leadsPath, []);
  const filters = readJson(leadFiltersPath, []).filter((filter) => filter.enabled && filter.scope === "dialing");
  const filterContext = { lists, campaigns, metrics: leadCallMetrics() };
  const now = Date.now();
  const joinedCampaign = campaigns.some((campaign) => {
    if (campaign.status !== "active") return false;
    const members = Array.isArray(campaign.advisorExtensions) ? campaign.advisorExtensions.map(String) : [];
    return campaign.openEnrollment === true ? members.includes(String(user.extension)) : (!members.length || members.includes(String(user.extension)));
  });
  if (!joinedCampaign) return response.json({ lead: null, message: "Join an active campaign before loading a lead" });
  for (const lead of leads) {
    if (lead.status === "reserved" && now - new Date(lead.reservedAt).getTime() > 20 * 60 * 1000) {
      lead.status = lead.previousStatus || "new";
      delete lead.reservedBy; delete lead.reservedAt; delete lead.previousStatus;
    }
  }
  const callback = leads.find((lead) => lead.status === "callback" && leadIsEligible(lead, user, lists, campaigns, now, filters, filterContext));
  const eligible = leads.filter((lead) => leadIsEligible(lead, user, lists, campaigns, now, filters, filterContext));
  let selected = callback;
  if (!selected && eligible.length) {
    const byList = new Map();
    for (const lead of eligible) {
      if (!byList.has(lead.listId)) byList.set(lead.listId, []);
      byList.get(lead.listId).push(lead);
    }
    const availableLists = [...byList.keys()].map((listId) => lists.find((item) => item.id === listId)).filter(Boolean);
    const primaryLists = availableLists.filter((list) => list.kind !== "supplemental");
    const supplementalLists = availableLists.filter((list) => list.kind === "supplemental");
    const requestedSupplementalWeight = Math.min(95, supplementalLists.reduce((sum, list) => sum + Math.max(0, Number(list.blendPercent || 0)), 0));
    const supplementalScale = requestedSupplementalWeight && supplementalLists.length
      ? requestedSupplementalWeight / supplementalLists.reduce((sum, list) => sum + Math.max(1, Number(list.blendPercent || 0)), 0)
      : 0;
    const primaryWeight = primaryLists.length ? Math.max(5, 100 - requestedSupplementalWeight) / primaryLists.length : 0;
    const weightedLists = availableLists.map((list) => ({
      listId: list.id,
      weight: list.kind === "supplemental" ? Math.max(1, Number(list.blendPercent || 0)) * supplementalScale : primaryWeight,
    })).filter((item) => item.weight > 0);
    const totalWeight = weightedLists.reduce((sum, item) => sum + item.weight, 0);
    let draw = Math.random() * totalWeight;
    const chosen = weightedLists.find((item) => ((draw -= item.weight) <= 0)) || weightedLists[0];
    const pool = byList.get(chosen.listId);
    selected = pool[Math.floor(Math.random() * pool.length)];
  }
  if (!selected) {
    writeJson(leadsPath, leads);
    return response.json({ lead: null, message: "No callable leads are currently assigned" });
  }
  selected.previousStatus = selected.status;
  selected.status = "reserved";
  selected.reservedBy = user.username;
  selected.reservedAt = new Date().toISOString();
  selected.updatedAt = selected.reservedAt;
  writeJson(leadsPath, leads);
  response.json({ lead: publicLead(selected, lists, campaigns) });
});

function reservePowerDialBatch(user, count = powerDialBatchSize) {
  const lists = readJson(leadListsPath, []);
  const campaigns = readJson(campaignsPath, []);
  const leads = readJson(leadsPath, []);
  const filters = readJson(leadFiltersPath, []).filter((filter) => filter.enabled && filter.scope === "dialing");
  const filterContext = { lists, campaigns, metrics: leadCallMetrics() };
  const now = Date.now();
  for (const lead of leads) {
    if (lead.status === "reserved" && now - new Date(lead.reservedAt).getTime() > 20 * 60 * 1000) {
      lead.status = lead.previousStatus || "new";
      delete lead.reservedBy; delete lead.reservedAt; delete lead.previousStatus;
    }
  }
  const joined = campaigns.some((campaign) => {
    if (campaign.status !== "active") return false;
    const members = Array.isArray(campaign.advisorExtensions) ? campaign.advisorExtensions.map(String) : [];
    return campaign.openEnrollment === true ? members.includes(String(user.extension)) : (!members.length || members.includes(String(user.extension)));
  });
  if (!joined) return { leads: [], lists, campaigns, message: "Join an active campaign before starting Power Dial" };
  const eligible = leads.filter((lead) => leadIsEligible(lead, user, lists, campaigns, now, filters, filterContext));
  const callbacks = eligible.filter((lead) => lead.status === "callback").sort((left, right) => new Date(left.callbackAt) - new Date(right.callbackAt));
  const regular = eligible.filter((lead) => lead.status !== "callback").sort(() => Math.random() - 0.5);
  const selected = [...callbacks, ...regular].slice(0, count);
  const reservedAt = new Date().toISOString();
  for (const lead of selected) {
    lead.previousStatus = lead.status;
    lead.status = "reserved";
    lead.reservedBy = user.username;
    lead.reservedAt = reservedAt;
    lead.updatedAt = reservedAt;
  }
  writeJson(leadsPath, leads);
  return { leads: selected, lists, campaigns, message: selected.length ? "" : "No callable leads are currently assigned" };
}

function releasePowerDialBatch(batch, { keepWinner = false } = {}) {
  if (!batch) return;
  const leads = readJson(leadsPath, []);
  let changed = false;
  for (const line of batch.lines) {
    if (keepWinner && line.leadId === batch.winnerLeadId) continue;
    const lead = leads.find((item) => item.id === line.leadId);
    if (!lead || lead.reservedBy !== batch.username || lead.status !== "reserved") continue;
    lead.status = lead.previousStatus || "new";
    delete lead.reservedBy; delete lead.reservedAt; delete lead.previousStatus;
    lead.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) writeJson(leadsPath, leads);
}


app.post("/api/preview-dial/reserve", requireAuth, (request, response) => {
  const user = request.session.user;
  if (!user.extension) return response.status(403).json({ error: "No phone extension assigned" });

  const count = Math.max(1, Math.min(10, Number(request.body?.count || 10)));
  const reserved = reservePowerDialBatch(user, count);

  response.json({
    leads: reserved.leads.map((lead) => publicLead(lead, reserved.lists, reserved.campaigns)),
    message: reserved.message || ""
  });
});

app.post("/api/power-dial/start", requireAuth, async (request, response) => {
  const user = request.session.user;
  if (!user.extension) return response.status(403).json({ error: "No phone extension assigned" });
  const active = powerDialBatches.get(user.username);
  if (active && !["complete", "stopped"].includes(active.status)) return response.status(409).json({ error: "A Power Dial batch is already active", batch: powerDialPublicBatch(active) });
  const reserved = reservePowerDialBatch(user, powerDialBatchSize);
  if (!reserved.leads.length) return response.json({ batch: null, message: reserved.message });
  const batch = {
    id: crypto.randomUUID(), username: user.username, extension: String(user.extension), status: "dialing",
    winnerLeadId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lines: [],
  };
  batch.lines = reserved.leads.map((lead) => ({
    leadId: lead.id, name: leadName(lead), phone: lead.phone, status: "queued", detail: "Waiting for dialer",
    channel: null, finalized: false, startedAt: null, endedAt: null, updatedAt: batch.createdAt,
  }));
  powerDialBatches.set(user.username, batch);
  fs.appendFileSync(activityPath, `${JSON.stringify({ at: batch.createdAt, user: user.username, type: "power_dial_batch_started", batchId: batch.id, size: batch.lines.length })}\n`, { mode: 0o600 });

  await Promise.allSettled(batch.lines.map(async (line, index) => {
    if (index) await new Promise((resolve) => setTimeout(resolve, index * 120));
    const raw = String(line.phone || "").replace(/\D/g, "");
    const number = raw.length === 10 ? `1${raw}` : raw;
    if (!/^1[2-9][0-9]{9}$/.test(number)) {
      updatePowerDialLine(batch, line, "failed", "Invalid phone number");
      finishPowerDialLead(batch, line, "failed");
      return;
    }
    const actionId = `power:${batch.id}:${line.leadId}`;
    powerDialActionIndex.set(actionId, { batchId: batch.id, leadId: line.leadId });
    updatePowerDialLine(batch, line, "dialing", "Sending to carrier");
    try {
      await amiAction({
        Action: "Originate",
        ActionID: actionId,
        Channel: `PJSIP/+${number}@twilio`,
        Context: "power-dial-screen",
        Exten: "s",
        Priority: "1",
        CallerID: "Travel Empire <+17252249003>",
        Variable: [`POWER_BATCH_ID=${batch.id}`, `POWER_LEAD_ID=${line.leadId}`, `POWER_ADVISOR_EXTENSION=${batch.extension}`],
        Async: "true",
        Timeout: "45000",
      });
      updatePowerDialLine(batch, line, "ringing", "Carrier accepted call");
      fs.appendFileSync(activityPath, `${JSON.stringify({ at: new Date().toISOString(), user: batch.username, type: "call_started", direction: "power", destination: `***${number.slice(-4)}`, leadId: line.leadId, batchId: batch.id })}\n`, { mode: 0o600 });
    } catch (error) {
      updatePowerDialLine(batch, line, "failed", error.message);
      finishPowerDialLead(batch, line, "failed");
    }
    refreshPowerDialBatchStatus(batch);
  }));
  response.status(201).json({ batch: powerDialPublicBatch(batch) });
});

app.get("/api/power-dial/status", requireAuth, (request, response) => {
  response.json({ batch: powerDialPublicBatch(powerDialBatches.get(request.session.user.username)) });
});

app.post("/api/power-dial/connected", requireAuth, (request, response) => {
  const batch = powerDialBatches.get(request.session.user.username);
  if (!batch || !batch.winnerLeadId) return response.json({ ok: true });
  const line = batch.lines.find((item) => item.leadId === batch.winnerLeadId);
  updatePowerDialLine(batch, line, "connected", "Connected to advisor");
  batch.status = "connected";
  response.json({ ok: true, batch: powerDialPublicBatch(batch) });
});

app.post("/api/power-dial/stop", requireAuth, async (request, response) => {
  const batch = powerDialBatches.get(request.session.user.username);
  if (!batch) return response.json({ ok: true, batch: null });
  batch.status = "stopped";
  for (const line of batch.lines) {
    if (!powerDialTerminal(line.status) && line.status !== "connected") {
      updatePowerDialLine(batch, line, "cancelled", "Stopped by advisor");
      await hangupPowerDialLine(line);
    }
  }
  releasePowerDialBatch(batch, { keepWinner: Boolean(batch.winnerLeadId) });
  response.json({ ok: true, batch: powerDialPublicBatch(batch) });
});

app.post("/api/power-dial/complete", requireAuth, (request, response) => {
  const batch = powerDialBatches.get(request.session.user.username);
  if (batch) {
    batch.status = "complete";
    batch.updatedAt = new Date().toISOString();
  }
  response.json({ ok: true });
});

app.put("/api/leads/:id/notes", requireAuth, (request, response) => {
  const leads = readJson(leadsPath, []);
  const lead = leads.find((item) => item.id === request.params.id);
  if (!lead) return response.status(404).json({ error: "Lead not found" });
  if (request.session.user.role !== "admin" && lead.reservedBy !== request.session.user.username) return response.status(403).json({ error: "This lead is not assigned to you" });
  lead.notes = String(request.body.notes || "").slice(0, 12000);
  lead.updatedAt = new Date().toISOString();
  writeJson(leadsPath, leads);
  response.json({ ok: true, savedAt: lead.updatedAt });
});

app.post("/api/leads/:id/disposition", requireAuth, (request, response) => {
  const layout = readJson(layoutPath, defaultLayout);
  const disposition = layout.dispositions.find((item) => item.id === request.body.dispositionId);
  if (!disposition) return response.status(400).json({ error: "Choose a valid disposition" });
  const leads = readJson(leadsPath, []);
  const lead = leads.find((item) => item.id === request.params.id);
  if (!lead) return response.status(404).json({ error: "Lead not found" });
  if (request.session.user.role !== "admin" && lead.reservedBy !== request.session.user.username) return response.status(403).json({ error: "This lead is not assigned to you" });
  const lists = readJson(leadListsPath, []);
  const list = lists.find((item) => item.id === lead.listId);
  lead.dispositionId = disposition.id;
  lead.dispositionLabel = disposition.label;
  lead.attempts = Number(lead.attempts || 0) + 1;
  lead.lastContactAt = new Date().toISOString();
  lead.lastAdvisor = request.session.user.username;
  if (disposition.action === "suppress" || disposition.id === "dnc") {
    lead.status = "suppressed";
    const dnc = new Set(readJson(dncPath, [])); dnc.add(lead.phone); writeJson(dncPath, [...dnc]);
  } else if (disposition.action === "callback" || disposition.id === "callback") {
    const callbackAt = new Date(request.body.callbackAt || Date.now() + 24 * 60 * 60 * 1000);
    if (!Number.isFinite(callbackAt.getTime())) return response.status(400).json({ error: "Choose a valid callback date and time" });
    lead.status = "callback"; lead.callbackAt = callbackAt.toISOString(); lead.callbackOwner = request.session.user.username;
  } else if (disposition.action === "retry" || ["no-answer", "voicemail"].includes(disposition.id)) {
    lead.status = "retry"; lead.availableAt = new Date(Date.now() + Number(list?.retryMinutes || 240) * 60 * 1000).toISOString();
  } else if (disposition.action === "sale" || disposition.id === "sale") lead.status = "sale";
  else lead.status = "complete";
  delete lead.reservedBy; delete lead.reservedAt; delete lead.previousStatus;
  lead.updatedAt = new Date().toISOString();
  writeJson(leadsPath, leads);
  fs.appendFileSync(activityPath, `${JSON.stringify({ at: lead.updatedAt, user: request.session.user.username, type: "disposition", leadId: lead.id, disposition: disposition.label })}\n`, { mode: 0o600 });
  const isSale = disposition.action === "sale" || disposition.id === "sale";
  response.json({ ok: true, lead: publicLead(lead, lists), saleUrl: isSale ? empireInsightsSaleUrl(lead) : null });
});
app.get("/api/admin/field-mappings", requireAuth, requireAdmin, (_request, response) => {
  response.json({ mappings: JSON.parse(fs.readFileSync(fieldMappingsPath, "utf8")) });
});
app.post("/api/admin/field-mappings", requireAuth, requireAdmin, (request, response) => {
  const campaignId = String(request.body.campaignId || "").trim();
  const name = String(request.body.name || "").trim().slice(0, 80);
  const fields = Array.isArray(request.body.fields) ? request.body.fields : [];
  if (!campaignId || !name || !fields.length) return response.status(400).json({ error: "Campaign, mapping name, and at least one field are required" });
  const normalized = fields.map((field) => ({
    source: String(field.source || "").trim().slice(0, 120),
    destination: String(field.destination || "").trim().slice(0, 80),
    required: Boolean(field.required),
  })).filter((field) => field.source && field.destination);
  if (!normalized.length) return response.status(400).json({ error: "Map at least one CSV column" });
  if (new Set(normalized.map((field) => field.destination)).size !== normalized.length) {
    return response.status(400).json({ error: "Each call field may be mapped only once" });
  }
  const mappings = JSON.parse(fs.readFileSync(fieldMappingsPath, "utf8"));
  const mapping = { id: crypto.randomUUID(), campaignId, name, fields: normalized, createdAt: new Date().toISOString() };
  mappings.push(mapping);
  fs.writeFileSync(fieldMappingsPath, `${JSON.stringify(mappings, null, 2)}\n`, { mode: 0o600 });
  response.status(201).json({ mapping });
});
app.post("/api/activity", requireAuth, (request, response) => {
  const allowed = new Set(["shift_start", "status", "call_started", "call_connected", "call_ended", "disposition", "lead_loaded", "transfer", "mason"]);
  if (!allowed.has(request.body.type)) return response.status(400).json({ error: "Invalid activity type" });
  const entry = { at: new Date().toISOString(), user: request.session.user.username, ...request.body };
  fs.appendFileSync(activityPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  response.status(201).json({ ok: true });
});

app.get("/api/phone", requireAuth, (request, response) => {
  const user = request.session.user;
  if (!["advisor", "admin"].includes(user.role) || !user.extension) return response.status(403).json({ error: "No phone assigned" });
  const number = Number(user.extension) - 1000;
  response.json({
    extension: user.extension,
    password: advisorSecrets[`ADVISOR_${number}_SIP_PASSWORD`],
    displayName: user.displayName,
    domain: publicHost,
    websocket: `wss://${publicHost}/ws`,
  });
});

function parseAmiMessage(raw) {
  return Object.fromEntries(raw.split("\r\n").filter(Boolean).map((line) => {
    const index = line.indexOf(":");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
}

function amiAction(action, completeEvent = null) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 5038 });
    let buffer = "";
    let authenticated = false;
    let actionSent = false;
    const events = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Asterisk manager timed out"));
    }, 5000);

    function send(fields) {
      const headers = Object.entries(fields).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${key}: ${item}`));
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    }

    socket.on("connect", () => send({
      Action: "Login",
      Username: amiSecrets.AMI_USERNAME,
      Secret: amiSecrets.AMI_PASSWORD,
      Events: "on",
    }));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      buffer = buffer.replace(/^Asterisk Call Manager[^\r\n]*\r\n/, "");
      let boundary;
      while ((boundary = buffer.indexOf("\r\n\r\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 4);
        const message = parseAmiMessage(raw);
        if (!authenticated) {
          if (message.Response === "Success") {
            authenticated = true;
            send(action);
            actionSent = true;
          } else if (message.Response === "Error") {
            clearTimeout(timeout);
            socket.destroy();
            reject(new Error("Asterisk manager login failed"));
          }
          continue;
        }
        if (!actionSent) continue;
        if (message.Event) events.push(message);
        if (completeEvent && message.Event === completeEvent) {
          clearTimeout(timeout);
          send({ Action: "Logoff" });
          socket.end();
          return resolve({ response: { Response: "Success" }, events });
        }
        if (!completeEvent && message.Response) {
          clearTimeout(timeout);
          send({ Action: "Logoff" });
          socket.end();
          if (message.Response === "Success") return resolve({ response: message, events });
          return reject(new Error(message.Message || "Asterisk rejected the request"));
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function powerDialPublicBatch(batch) {
  if (!batch) return null;
  const lists = readJson(leadListsPath, []);
  const campaigns = readJson(campaignsPath, []);
  const leads = readJson(leadsPath, []);
  const winner = batch.winnerLeadId ? leads.find((lead) => lead.id === batch.winnerLeadId) : null;
  return {
    id: batch.id,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    winnerLeadId: batch.winnerLeadId || null,
    winnerLead: winner ? publicLead(winner, lists, campaigns) : null,
    lines: batch.lines.map((line, index) => {
      const lead = leads.find((item) => item.id === line.leadId);
      return {
        slot: index + 1,
        leadId: line.leadId,
        name: lead ? leadName(lead) : line.name,
        phone: lead?.phone || line.phone,
        status: line.status,
        detail: line.detail || "",
        startedAt: line.startedAt,
        updatedAt: line.updatedAt,
      };
    }),
  };
}

function powerDialLine(batchId, leadId) {
  const batch = [...powerDialBatches.values()].find((item) => item.id === batchId);
  return { batch, line: batch?.lines.find((item) => item.leadId === leadId) };
}

function updatePowerDialLine(batch, line, status, detail = "") {
  const now = new Date().toISOString();
  if (!line.startedAt && ["dialing", "ringing", "amd", "human", "connected", "failed", "machine", "no-answer", "cancelled"].includes(status)) line.startedAt = now;
  if (["failed", "machine", "no-answer", "cancelled", "connected"].includes(status) && !line.endedAt) line.endedAt = now;
  if (!batch || !line) return;
  line.status = status;
  line.detail = detail;
  line.updatedAt = new Date().toISOString();
  batch.updatedAt = line.updatedAt;
}

function finishPowerDialLead(batch, line, result) {
  if (!batch || !line || line.finalized || batch.winnerLeadId === line.leadId) return;
  line.finalized = true;
  const leads = readJson(leadsPath, []);
  const lists = readJson(leadListsPath, []);
  const lead = leads.find((item) => item.id === line.leadId);
  if (!lead) return;
  if (result === "cancelled") {
    lead.status = lead.previousStatus || "new";
    delete lead.reservedBy; delete lead.reservedAt; delete lead.previousStatus;
    lead.updatedAt = new Date().toISOString();
    writeJson(leadsPath, leads);
    fs.appendFileSync(activityPath, `${JSON.stringify({ at: lead.updatedAt, user: batch.username, type: "power_dial_cancelled", leadId: lead.id, batchId: batch.id })}\n`, { mode: 0o600 });
    return;
  }
  const list = lists.find((item) => item.id === lead.listId);
  const disposition = result === "machine" ? "Voicemail" : result === "busy" ? "Busy" : "No Answer";
  lead.dispositionId = result === "machine" ? "voicemail" : "no-answer";
  lead.dispositionLabel = disposition;
  lead.attempts = Number(lead.attempts || 0) + 1;
  lead.lastContactAt = new Date().toISOString();
  lead.lastAdvisor = batch.username;
  lead.status = "retry";
  lead.availableAt = new Date(Date.now() + Number(list?.retryMinutes || 240) * 60 * 1000).toISOString();
  delete lead.reservedBy; delete lead.reservedAt; delete lead.previousStatus;
  lead.updatedAt = lead.lastContactAt;
  writeJson(leadsPath, leads);
  fs.appendFileSync(activityPath, `${JSON.stringify({ at: lead.updatedAt, user: batch.username, type: "power_dial_result", leadId: lead.id, result, disposition })}\n`, { mode: 0o600 });
}

function powerDialTerminal(status) {
  return new Set(["machine", "busy", "no-answer", "failed", "cancelled", "disconnected"]).has(status);
}

function refreshPowerDialBatchStatus(batch) {
  if (!batch || batch.status === "stopped") return;
  if (batch.winnerLeadId) batch.status = batch.lines.find((line) => line.leadId === batch.winnerLeadId)?.status === "connected" ? "connected" : "human-found";
  else if (batch.lines.every((line) => powerDialTerminal(line.status))) batch.status = "complete";
  else batch.status = "dialing";
  batch.updatedAt = new Date().toISOString();
}

async function hangupPowerDialLine(line) {
  if (!line?.channel) return;
  await amiAction({ Action: "Hangup", Channel: line.channel, Cause: "16" }).catch(() => {});
}

async function handlePowerDialEvent(event) {
  if (event.Event === "OriginateResponse" && String(event.ActionID || "").startsWith("power:")) {
    const indexed = powerDialActionIndex.get(event.ActionID);
    if (!indexed) return;
    const { batch, line } = powerDialLine(indexed.batchId, indexed.leadId);
    if (!batch || !line) return;
    if (event.Channel) {
      line.channel = event.Channel;
      powerDialChannelIndex.set(event.Channel, indexed);
    }
    if (event.Uniqueid) powerDialChannelIndex.set(event.Uniqueid, indexed);
    if (event.Response === "Failure") {
      const reason = String(event.Reason || event.Message || "");
      const status = /busy|17/i.test(reason) ? "busy" : /no answer|18|19/i.test(reason) ? "no-answer" : "failed";
      updatePowerDialLine(batch, line, status, reason || "Originate failed");
      finishPowerDialLead(batch, line, status);
      refreshPowerDialBatchStatus(batch);
    }
    return;
  }

  if (event.Event === "UserEvent" && ["PowerDialStatus", "PowerDialResult"].includes(event.UserEvent)) {
    const batchId = String(event.BatchId || "");
    const leadId = String(event.LeadId || "");
    const { batch, line } = powerDialLine(batchId, leadId);
    if (!batch || !line) return;
    if (event.Channel) {
      line.channel = event.Channel;
      powerDialChannelIndex.set(event.Channel, { batchId, leadId });
    }
    if (event.UserEvent === "PowerDialStatus") {
      const status = String(event.Status || "dialing").toLowerCase();
      updatePowerDialLine(batch, line, status, String(event.Detail || ""));
      if (status === "connected") batch.status = "connected";
      refreshPowerDialBatchStatus(batch);
      return;
    }
    const result = String(event.Result || "NOTSURE").toUpperCase();
    const cause = String(event.Cause || "");
    if (result !== "HUMAN") {
      updatePowerDialLine(batch, line, result === "MACHINE" ? "machine" : "no-answer", cause || result);
      finishPowerDialLead(batch, line, result === "MACHINE" ? "machine" : "no-answer");
      refreshPowerDialBatchStatus(batch);
      return;
    }
    if (batch.winnerLeadId && batch.winnerLeadId !== leadId) {
      updatePowerDialLine(batch, line, "cancelled", "Another human connected first");
      finishPowerDialLead(batch, line, "cancelled");
      await hangupPowerDialLine(line);
      refreshPowerDialBatchStatus(batch);
      return;
    }
    batch.winnerLeadId = leadId;
    batch.status = "human-found";
    updatePowerDialLine(batch, line, "human", cause || "Human detected");
    for (const other of batch.lines) {
      if (other.leadId === leadId || powerDialTerminal(other.status)) continue;
      updatePowerDialLine(batch, other, "cancelled", "Human found on another line");
      finishPowerDialLead(batch, other, "cancelled");
      await hangupPowerDialLine(other);
    }
    if (line.channel) {
      await amiAction({ Action: "Redirect", Channel: line.channel, Context: "power-dial-connect", Exten: batch.extension, Priority: "1" }).catch((error) => {
        updatePowerDialLine(batch, line, "failed", error.message);
      });
    }
    refreshPowerDialBatchStatus(batch);
    return;
  }

  if (event.Event === "Hangup") {
    const indexed = powerDialChannelIndex.get(event.Channel) || powerDialChannelIndex.get(event.Uniqueid);
    if (!indexed) return;
    const { batch, line } = powerDialLine(indexed.batchId, indexed.leadId);
    if (!batch || !line || powerDialTerminal(line.status) || ["human", "connected"].includes(line.status)) return;
    const cause = Number(event.Cause || 0);
    const status = cause === 17 ? "busy" : [18, 19].includes(cause) ? "no-answer" : "disconnected";
    updatePowerDialLine(batch, line, status, event["Cause-txt"] || `Cause ${cause}`);
    finishPowerDialLead(batch, line, status);
    refreshPowerDialBatchStatus(batch);
  }
}

let amiEventSocket = null;
let amiEventReconnectTimer = null;
function connectPowerDialAmiEvents() {
  clearTimeout(amiEventReconnectTimer);
  amiEventSocket?.destroy();
  const socket = net.createConnection({ host: "127.0.0.1", port: 5038 });
  amiEventSocket = socket;
  let buffer = "";
  socket.on("connect", () => socket.write(`Action: Login\r\nUsername: ${amiSecrets.AMI_USERNAME}\r\nSecret: ${amiSecrets.AMI_PASSWORD}\r\nEvents: on\r\n\r\n`));
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    buffer = buffer.replace(/^Asterisk Call Manager[^\r\n]*\r\n/, "");
    let boundary;
    while ((boundary = buffer.indexOf("\r\n\r\n")) !== -1) {
      const event = parseAmiMessage(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 4);
      if (event.Event) handlePowerDialEvent(event).catch((error) => console.error("Power dial AMI event failed", error));
    }
  });
  const reconnect = () => {
    if (amiEventSocket === socket) amiEventSocket = null;
    clearTimeout(amiEventReconnectTimer);
    amiEventReconnectTimer = setTimeout(connectPowerDialAmiEvents, 2000);
  };
  socket.on("error", reconnect);
  socket.on("close", reconnect);
}

async function queueMembers() {
  const result = await amiAction({ Action: "QueueStatus", Queue: "incoming-sales" }, "QueueStatusComplete");
  return result.events
    .filter((event) => event.Event === "QueueMember" && event.Queue === "incoming-sales")
    .map((event) => ({
      extension: (String(event.Interface || event.Location || "").match(/100[1-4]/) || [""])[0],
      interface: event.Interface || event.Location,
      paused: event.Paused === "1",
      inCall: event.InCall === "1",
      status: event.Status,
    }));
}

app.get("/api/queue", requireAuth, async (request, response) => {
  try {
    response.json({ members: await queueMembers() });
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.post("/api/queue/:extension/:operation", requireAuth, async (request, response) => {
  const { extension, operation } = request.params;
  const validExtensions = new Set(["1001", "1002", "1003", "1004"]);
  if (!validExtensions.has(extension) || !["join", "leave"].includes(operation)) {
    return response.status(400).json({ error: "Invalid queue request" });
  }
  if (request.session.user.role !== "admin" && request.session.user.extension !== extension) {
    return response.status(403).json({ error: "You may only change your own queue status" });
  }
  const action = operation === "join"
    ? { Action: "QueueAdd", Queue: "incoming-sales", Interface: `PJSIP/${extension}`, MemberName: extension, Paused: "false" }
    : { Action: "QueueRemove", Queue: "incoming-sales", Interface: `PJSIP/${extension}` };
  try {
    await amiAction(action);
    response.json({ ok: true, members: await queueMembers() });
  } catch (error) {
    if (operation === "join" && /already/i.test(error.message)) return response.json({ ok: true, members: await queueMembers() });
    if (operation === "leave" && /not there|not found/i.test(error.message)) return response.json({ ok: true, members: await queueMembers() });
    response.status(502).json({ error: error.message });
  }
});

app.get("/api/to", requireAuth, async (_request, response) => {
  const users = readUsers().filter((user) => user.extension && ["advisor", "admin"].includes(user.role));
  try {
    const result = await amiAction({ Action: "PJSIPShowEndpoints" }, "EndpointListComplete");
    const endpointEvents = result.events.filter((event) => event.Event === "EndpointList");
    const people = users.map((user) => {
      const endpoint = endpointEvents.find((event) => String(event.ObjectName || event.Endpoint || "") === String(user.extension));
      const deviceState = String(endpoint?.DeviceState || "Unavailable");
      const activeChannels = Number(endpoint?.ActiveChannels || 0);
      const available = /not in use|available/i.test(deviceState) && activeChannels === 0;
      return { extension: user.extension, displayName: user.displayName, role: user.role, available, status: available ? "available" : /unavailable/i.test(deviceState) ? "offline" : "busy" };
    });
    response.json({ people });
  } catch {
    const members = await queueMembers().catch(() => []);
    response.json({ people: users.map((user) => {
      const member = members.find((item) => item.extension === user.extension);
      const available = Boolean(member && !member.inCall && String(member.status) === "1");
      return { extension: user.extension, displayName: user.displayName, role: user.role, available, status: available ? "available" : member ? "busy" : "offline" };
    }) });
  }
});

app.get("/api/mason/status", requireAuth, (_request, response) => {
  response.json({ configured: Boolean(openAiApiKey), model: openAiApiKey ? masonModel : null, transcriptionModel: openAiApiKey ? transcriptionModel : null });
});

app.post("/api/mason/transcribe", requireAuth, express.raw({ type: ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"], limit: "6mb" }), async (request, response) => {
  if (!openAiApiKey) return response.status(503).json({ error: "Mason Live requires OPENAI_API_KEY" });
  if (!Buffer.isBuffer(request.body) || request.body.length < 1000) return response.status(400).json({ error: "No call audio received" });
  try {
    const contentType = String(request.get("content-type") || "audio/webm").split(";")[0];
    const extension = contentType.includes("ogg") ? "ogg" : contentType.includes("mp4") ? "mp4" : contentType.includes("mpeg") ? "mp3" : "webm";
    const form = new FormData();
    form.append("model", transcriptionModel);
    form.append("file", new Blob([request.body], { type: contentType }), `call-chunk.${extension}`);
    form.append("prompt", "Travel Empire vacation sales call. Common terms include Empire Escape, Empire Voyages, Travel Empire, Save-On Travel, Time 2 Travel, Las Vegas, Orlando, dining credit, cruise, condominium, and airfare.");
    const result = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${openAiApiKey}` }, body: form });
    const body = await result.json().catch(() => ({}));
    if (!result.ok) return response.status(502).json({ error: body.error?.message || "Mason transcription failed" });
    response.json({ text: String(body.text || "").trim() });
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

function responseText(body) {
  if (body.output_text) return String(body.output_text);
  for (const item of body.output || []) {
    for (const content of item.content || []) if (content.type === "output_text" && content.text) return String(content.text);
  }
  return "";
}

app.post("/api/mason/ask", requireAuth, async (request, response) => {
  if (!openAiApiKey) return response.status(503).json({ error: "Mason requires OPENAI_API_KEY on the EmpireConnection server" });
  const question = String(request.body.question || "").trim().slice(0, 1200);
  const transcript = String(request.body.transcript || "").slice(-16000);
  const script = String(request.body.script || "").slice(0, 12000);
  const lead = request.body.lead && typeof request.body.lead === "object" ? request.body.lead : {};
  if (!question) return response.status(400).json({ error: "Ask Mason a question" });
  try {
    const result = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: masonModel,
        instructions: "You are Mason, Travel Empire's live advisor coach. Give concise, truthful, compliant sales coaching. Help with value creation, discovery questions, wording, and rebuttals. Never invent package benefits, guarantees, discounts, eligibility, or customer facts. Do not pressure vulnerable customers. Respond with the exact words the advisor can say first, followed by one short coaching note when useful.",
        input: `Advisor: ${request.session.user.displayName}\nCustomer: ${lead.fullName || "Unknown"}\nCampaign: ${lead.campaignName || "Unknown"}\nApproved script:\n${script || "Not provided"}\n\nRecent call transcript:\n${transcript || "No transcript yet"}\n\nAdvisor request: ${question}`,
        max_output_tokens: 500,
      }),
    });
    const body = await result.json().catch(() => ({}));
    if (!result.ok) return response.status(502).json({ error: body.error?.message || "Mason could not respond" });
    const answer = responseText(body).trim();
    if (!answer) return response.status(502).json({ error: "Mason returned an empty response" });
    response.json({ answer });
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, (request, response) => {
  const users = readUsers();
  const assigned = new Set(users.map((user) => user.extension).filter(Boolean));
  const availableExtensions = Object.entries(advisorSecrets)
    .filter(([key]) => /_SIP_USER$/.test(key))
    .map(([, value]) => value)
    .filter((extension) => !assigned.has(extension))
    .sort();
  response.json({ users: users.map(safeUser), availableExtensions });
});

app.post("/api/admin/users", requireAuth, requireAdmin, (request, response) => {
  const displayName = String(request.body.displayName || "").trim();
  const email = String(request.body.email || "").trim().toLowerCase();
  const username = email.split("@")[0];
  const extension = String(request.body.extension || "").trim();
  if (displayName.length < 2 || displayName.length > 80) return response.status(400).json({ error: "Enter the advisor's name" });
  if (!/^[a-z0-9._%+-]+@travelempire\.org$/.test(email)) return response.status(400).json({ error: "Enter the advisor's EmpireInsights email" });
  const configuredExtensions = new Set(Object.entries(advisorSecrets).filter(([key]) => /_SIP_USER$/.test(key)).map(([, value]) => value));
  if (!configuredExtensions.has(extension)) return response.status(400).json({ error: "Select an available extension" });
  const users = readUsers();
  if (users.some((user) => user.email === email || user.username === username)) return response.status(409).json({ error: "That EmpireInsights advisor is already assigned" });
  if (users.some((user) => user.extension === extension)) return response.status(409).json({ error: "That extension is already assigned" });
  const user = {
    username,
    email,
    role: "advisor",
    displayName,
    extension,
    passwordHash: "sso-only",
    mustChangePassword: false,
    enabled: true,
  };
  users.push(user);
  writeUsers(users);
  response.status(201).json({ user: safeUser(user) });
});

app.get("/health", (_request, response) => response.json({ ok: true }));
app.use(express.static("public", { extensions: ["html"], maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.get("/{*splat}", (_request, response) => response.sendFile(path.resolve("public/index.html")));

app.listen(port, "127.0.0.1", () => {
  console.log(`EmpireConnection listening on http://127.0.0.1:${port}`);
  connectPowerDialAmiEvents();
});

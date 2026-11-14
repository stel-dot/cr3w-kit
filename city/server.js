// CR3W City backend: serves the dashboard and talks to the n8n API.
// Secrets (set in Replit > Secrets): N8N_BASE_URL, DASHBOARD_PASSWORD, and ONE of:
//   N8N_MCP_TOKEN  - from n8n Settings > Instance-level MCP > Connect > API key tab (works on every plan)
//   N8N_API_KEY    - from n8n Settings > n8n API (paid plans only)
const http = require('http');
const fs = require('fs');
const path = require('path');

const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'https://cr3w.app.n8n.cloud').replace(/\/+$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';
let N8N_MCP_TOKEN = process.env.N8N_MCP_TOKEN || '';
let PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const PORT = process.env.PORT || 3000;

// ---------- First-run setup (used on your own server) ----------
// If CONFIG_FILE is set, the n8n token and password can be entered on a /setup page
// (protected by SETUP_CODE) instead of typed into the server. They're saved to CONFIG_FILE.
const CONFIG_FILE = process.env.CONFIG_FILE || '';
const SETUP_CODE = process.env.SETUP_CODE || '';
function loadConfig() {
  if (!CONFIG_FILE) return;
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c.n8nMcpToken) N8N_MCP_TOKEN = c.n8nMcpToken;
    if (c.password) PASSWORD = c.password;
  } catch {}
}
loadConfig();
const needsSetup = () => !!CONFIG_FILE && !!SETUP_CODE && !(N8N_MCP_TOKEN && PASSWORD);
const SETUP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CR3W City setup</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0c1c;color:#eef;font:16px system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{width:100%;max-width:420px;background:#1b1834;border-radius:14px;padding:24px;display:grid;gap:14px}
h1{margin:0;font-size:22px}p{margin:0;color:#aab;font-size:14px;line-height:1.4}
label{display:grid;gap:6px;font-size:14px}input,textarea{font:inherit;padding:10px;border-radius:8px;border:1px solid #3a3666;background:#0e0c1c;color:#eef}
textarea{min-height:90px;font-size:12px}button{font:inherit;padding:12px;border:0;border-radius:8px;background:#7c5cff;color:#fff;font-weight:600}
#msg{color:#ff8a8a;font-size:14px;min-height:1em}</style></head><body>
<form id="f"><h1>Set up CR3W City</h1>
<p>Connects the city to your n8n and sets the password you'll use to open it. Come back here any time your n8n MCP token changes.</p>
<label>Setup code (shown on the server after install)<input name="code" autocomplete="off" required></label>
<label>n8n MCP token (n8n &rarr; Settings &rarr; Instance-level MCP &rarr; Connect &rarr; API key)<textarea name="token" required></textarea></label>
<label>Choose a CR3W City password<input name="password" type="password" minlength="6" required></label>
<button>Save</button><div id="msg"></div></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));
const r=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
const j=await r.json().catch(()=>({}));if(r.ok){location.href='/';}else{document.getElementById('msg').textContent=j.error||'Something went wrong';}};</script>
</body></html>`;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 20000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- Buildings and which bots live in them ----------
const BUSINESSES = [
  { id: 'cr3w',    name: 'CR3W Tower',     sub: 'Custom apparel · bulk orders', color: 0x8b6cff, x: 0,  z: 0, h: 11 },
  { id: 'youtube', name: 'YouTube Studio', sub: 'Clips and channel growth',     color: 0xff3b5c, x: 10, z: 4.5, h: 12 }
  // Future buildings: remove the // to open one. Each spot is already laid out on the city ring.
  // { id: 'etsy',     name: 'Etsy Shop',       sub: 'Digital + print listings', color: 0xff8a3d, x: -11, z: 5,  h: 7 },
  // { id: 'gamedev',  name: 'Game Dev Lab',    sub: 'Pig Pursuit and more',      color: 0x2bd99a, x: -8,  z: -10, h: 9 },
  // { id: 'contract', name: 'Contracting Co.', sub: 'Installs and HVAC jobs',    color: 0x2bd9c4, x: 8,   z: -10, h: 6 },
  // { id: 'lot',      name: 'Empty Lot',       sub: 'Room to expand',            color: 0x3a4280, x: 0,   z: 13, h: 0 }
];

// Match n8n workflow names to a building and a plain-English job.
// Any workflow not listed here moves into CR3W Tower with a generic job.
const BOT_INFO = {
  'Lead Scout': { biz: 'cr3w', job: 'Finds local businesses on Google Maps', kind: 'manual', schedule: 'Runs when you start it' },
  'Pitch Writer – Email 1': { biz: 'cr3w', job: 'Sends Email 1 to leads marked "new"', kind: 'manual', schedule: 'Runs when you start it' },
  'Follow-Up Rep': { biz: 'cr3w', job: 'Sends Emails 2 and 3 to leads who have not replied', kind: 'auto', schedule: 'Weekdays 9:00 AM' },
  'Reply Sorter': { biz: 'cr3w', job: 'Sorts replies and alerts you about hot leads', kind: 'auto', schedule: 'Checks inbox every 15 min' },
  'Call List Manager': { biz: 'cr3w', job: 'Emails your daily call list with scripts', kind: 'auto', schedule: 'Weekdays 8:00 AM' },
  'Review Requester': { biz: 'cr3w', job: 'Sends the thank-you survey after delivery', kind: 'auto', schedule: 'Daily 10:00 AM' },
  'Review Survey': { biz: 'cr3w', job: 'The survey page customers fill out', kind: 'auto', schedule: 'Always on (survey page)' },
  'Clip Scout': { biz: 'youtube', job: 'Finds this week\'s most-watched moments from your streamers', kind: 'auto', schedule: 'Every 6 hours' },
  'Trend Scout: YouTube': { biz: 'youtube', job: 'Studies the most-viewed Shorts of the week and their titles', kind: 'auto', schedule: 'Twice a day' },
  'Trend Scout: Twitch & Kick': { biz: 'youtube', job: 'Studies the most-watched named clips on Twitch and Kick', kind: 'auto', schedule: 'Twice a day' },
  'Title Analyst': { biz: 'youtube', job: 'Learns which titles win and hands the best formulas to the editors', kind: 'auto', schedule: 'Twice a day' },
  'Clip Scout 2': { biz: 'youtube', job: 'Catches today\'s fresh moments as they happen', kind: 'auto', schedule: 'Every 3 hours' },
  'Clip Editor': { biz: 'youtube', job: 'Turns top moments into Shorts and sends them to you', kind: 'auto', schedule: 'Even hours, 8 AM to 10 PM' },
  'Clip Editor 2': { biz: 'youtube', job: 'Second editor: makes Shorts on the hours in between', kind: 'auto', schedule: 'Odd hours, 9 AM to 9 PM' },
  'Studio Inbox': { biz: 'youtube', job: 'Handles your Approve / Decline / Posted choices', kind: 'auto', schedule: 'Always on (email buttons)' },
  'Compilation Builder': { biz: 'youtube', job: 'Builds the weekly 4 to 10 minute compilation', kind: 'auto', schedule: 'Sundays 5:00 PM' },
  'Gatekeeper': { biz: 'cr3w', job: 'Emails you when someone gets locked out for guessing your City password', kind: 'auto', schedule: 'Checks every 5 min' }
};
// kind/schedule are optional. If left out, the city looks them up in n8n (one extra request per bot, cached 1 hour).

// ---------- Password check (API only; the page itself shows a sign-in screen) ----------
function authorized(req) {
  if (!PASSWORD) return true;
  if ((req.headers['x-cr3w-pass'] || '') === PASSWORD) return true;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    if (decoded.slice(decoded.indexOf(':') + 1) === PASSWORD) return true;
  }
  return false;
}

// ---------- Lockout on bad passwords ----------
// 5 wrong City passwords from the same device (IP) locks it out for 15 minutes.
// Each lockout is written to the "Security Log" n8n data table; the Gatekeeper bot emails it to you.
const LOCK_AFTER = 5, LOCK_MINUTES = 15;
const SECURITY_TABLE = process.env.SECURITY_TABLE || 'B5fUQ7XvgMSU0hP5';
const fails = new Map(); // ip -> { count, first, until }
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function lockedFor(ip) {
  const f = fails.get(ip);
  if (!f || !f.until) return 0;
  const left = f.until - Date.now();
  if (left <= 0) { fails.delete(ip); return 0; }
  return left;
}
function noteFailure(ip, req) {
  const now = Date.now();
  let f = fails.get(ip);
  if (!f || now - f.first > LOCK_MINUTES * 60000) f = { count: 0, first: now, until: 0 };
  f.count++;
  if (f.count >= LOCK_AFTER) {
    f.until = now + LOCK_MINUTES * 60000;
    logSecurity('lockout', ip, `${f.count} wrong City passwords; locked for ${LOCK_MINUTES} min. Device: ${String(req.headers['user-agent'] || 'unknown').slice(0, 160)}`);
  }
  fails.set(ip, f);
  if (fails.size > 5000) fails.clear(); // memory guard
}
function logSecurity(event, ip, detail) {
  if (!N8N_MCP_TOKEN) return;
  mcpTool('add_data_table_rows', { dataTableId: SECURITY_TABLE, projectId: STUDIO_PROJECT,
    rows: [{ happened_at: new Date().toISOString(), event, ip, detail, emailed: false }] })
    .catch(e => console.error('security log failed:', e.message));
}

// ---------- n8n connection ----------
// Option A: n8n REST API (N8N_API_KEY)
async function n8nRest(pathname, options = {}) {
  const res = await fetch(N8N_BASE_URL + '/api/v1' + pathname, {
    ...options,
    headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) throw new Error('n8n said: ' + ((body && body.message) || res.statusText) + ' (' + res.status + ')');
  return body;
}

// Option B: n8n Instance-level MCP server (N8N_MCP_TOKEN)
const MCP_URL = N8N_BASE_URL + '/mcp-server/http';
let mcpSession = null;
let mcpId = 0;

function parseMcpBody(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{')) return JSON.parse(t);
  const lines = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const obj = JSON.parse(lines[i]); if (obj.result !== undefined || obj.error) return obj; } catch {}
  }
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

async function mcpPost(payload) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + N8N_MCP_TOKEN };
  if (mcpSession) headers['Mcp-Session-Id'] = mcpSession;
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) mcpSession = sid;
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404 || res.status === 400) mcpSession = null;
    throw new Error('n8n MCP said: ' + (text.slice(0, 200) || res.statusText) + ' (' + res.status + ')');
  }
  return parseMcpBody(text);
}

async function mcpInit() {
  mcpSession = null;
  await mcpPost({ jsonrpc: '2.0', id: ++mcpId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'cr3w-city', version: '1.0.0' } } });
  try { await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }); } catch {}
}

let mcpCooldownUntil = 0;
async function mcpTool(name, args, retried) {
  if (Date.now() < mcpCooldownUntil) throw new Error('n8n asked us to slow down. Trying again in a minute.');
  let msg;
  try {
    if (!mcpSession) await mcpInit();
    msg = await mcpPost({ jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: { name, arguments: args || {} } });
  } catch (err) {
    if (/\(429\)/.test(err.message)) { mcpCooldownUntil = Date.now() + 90 * 1000; throw err; }
    if (!retried) { mcpSession = null; return mcpTool(name, args, true); }
    throw err;
  }
  if (!msg) throw new Error('n8n MCP sent an empty reply');
  if (msg.error) {
    if (!retried) { mcpSession = null; return mcpTool(name, args, true); }
    throw new Error('n8n MCP: ' + (msg.error.message || 'error'));
  }
  const content = (msg.result && msg.result.content) || [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('');
  if (msg.result && msg.result.isError) throw new Error('n8n MCP: ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// Workflow details (nodes) change rarely, so cache them for 1 hour.
const detailCache = {};
async function workflowDetails(id) {
  const hit = detailCache[id];
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.wf;
  const r = await mcpTool('get_workflow_details', { workflowId: id });
  const wf = r.workflow || r;
  detailCache[id] = { at: Date.now(), wf };
  return wf;
}

function requireConnection() {
  if (!N8N_API_KEY && !N8N_MCP_TOKEN) throw new Error('No n8n connection yet. Add N8N_MCP_TOKEN (or N8N_API_KEY) in Replit Secrets.');
}

async function getWorkflows() {
  requireConnection();
  if (N8N_API_KEY) return ((await n8nRest('/workflows?limit=100')).data || []);
  const list = (await mcpTool('search_workflows', { limit: 100 })).data || [];
  const out = [];
  for (const w of list) {
    if (w.isArchived) continue;
    let nodes = [];
    const known = BOT_INFO[w.name] && BOT_INFO[w.name].kind;
    if (!known) {
      const cached = detailCache[w.id] && Date.now() - detailCache[w.id].at < 60 * 60 * 1000;
      if (!cached) await new Promise(r => setTimeout(r, 1500));
      try { nodes = (await workflowDetails(w.id)).nodes || []; } catch {}
    }
    out.push({ ...w, nodes });
  }
  return out;
}

async function getExecutions() {
  requireConnection();
  if (N8N_API_KEY) return ((await n8nRest('/executions?limit=100')).data || []);
  return ((await mcpTool('search_workflow_executions', { limit: 100 })).data || []);
}

async function setActive(id, on) {
  requireConnection();
  if (N8N_API_KEY) return n8nRest('/workflows/' + encodeURIComponent(id) + '/' + (on ? 'activate' : 'deactivate'), { method: 'POST' });
  delete detailCache[id];
  return mcpTool(on ? 'publish_workflow' : 'unpublish_workflow', { workflowId: id });
}

const TRIGGER_TYPES_THAT_CAN_ACTIVATE = ['scheduleTrigger', 'gmailTrigger', 'formTrigger', 'webhook', 'cron'];

function triggerKind(workflow) {
  const nodes = workflow.nodes || [];
  const triggers = nodes.filter(n => /trigger|webhook/i.test(n.type));
  if (triggers.some(n => TRIGGER_TYPES_THAT_CAN_ACTIVATE.some(t => n.type.endsWith(t)))) return 'auto';
  return 'manual';
}

function scheduleText(workflow) {
  const t = (workflow.nodes || []).find(n => /trigger|webhook/i.test(n.type));
  if (!t) return '';
  if (t.type.endsWith('formTrigger')) return 'Always on (survey page)';
  if (t.type.endsWith('gmailTrigger')) return 'Checks inbox every 15 min';
  if (t.type.endsWith('manualTrigger')) return 'Runs when you start it';
  const rule = t.parameters && t.parameters.rule && t.parameters.rule.interval && t.parameters.rule.interval[0];
  const cron = rule && rule.expression;
  if (cron) {
    const [m, h, , , dow] = cron.split(' ');
    const hour = Number(h);
    const time = (hour % 12 || 12) + ':' + String(m).padStart(2, '0') + (hour < 12 ? ' AM' : ' PM');
    return (dow === '1-5' ? 'Weekdays ' : 'Daily ') + time;
  }
  return 'Scheduled';
}

function fmtTime(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function isToday(iso) {
  if (!iso) return false;
  const opts = { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' };
  return new Date(iso).toLocaleDateString('en-US', opts) === new Date().toLocaleDateString('en-US', opts);
}

// ---------- City data ----------
// n8n limits how often it can be asked, so share one answer for 60 seconds
// and keep showing the last good answer if n8n says "too many requests".
const CACHE_MS = 60 * 1000;
let cityCache = null;
let cityInflight = null;

async function cityData() {
  if (cityCache && Date.now() - cityCache.at < CACHE_MS) return cityCache.data;
  if (cityInflight) return cityInflight;
  cityInflight = buildCityData()
    .then(data => { cityCache = { at: Date.now(), data }; return data; })
    .catch(err => {
      if (cityCache) return { ...cityCache.data, stale: true, staleReason: err.message };
      throw err;
    })
    .finally(() => { cityInflight = null; });
  return cityInflight;
}

async function buildCityData() {
    const workflows = (await getWorkflows()).filter(w => !w.isArchived && !/^Setup:/i.test(w.name));
    const executions = (await getExecutions()).slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

    const bots = workflows.map(w => {
      const info = BOT_INFO[w.name] || { biz: 'cr3w', job: 'Custom bot' };
      const runs = executions.filter(e => String(e.workflowId) === String(w.id));
      const last = runs[0];
      const todayRuns = runs.filter(e => isToday(e.startedAt));
      const todayFails = todayRuns.filter(e => e.status === 'error' || e.status === 'crashed').length;
      const kind = info.kind || triggerKind(w);

      let status;
      if (last && (last.status === 'error' || last.status === 'crashed')) status = 'error';
      else if (kind === 'manual') status = 'waiting';
      else if (!w.active) status = 'paused';
      else status = 'running';

      let today;
      if (todayRuns.length === 0) today = 'No runs today';
      else today = todayRuns.length + ' run' + (todayRuns.length === 1 ? '' : 's') + ' today' + (todayFails ? ' · ' + todayFails + ' failed' : '');

      return {
        id: w.id,
        name: w.name,
        biz: info.biz,
        job: info.job,
        schedule: info.schedule || scheduleText(w),
        kind,
        active: !!w.active,
        status,
        today,
        last: last ? fmtTime(last.startedAt) : 'Never',
        err: status === 'error' ? 'Last run failed. Open it in n8n to see why.' : null,
        editorUrl: N8N_BASE_URL + '/workflow/' + w.id
      };
    });

    const nameById = Object.fromEntries(workflows.map(w => [String(w.id), w.name]));
    const feed = executions
      .filter(e => nameById[String(e.workflowId)])
      .slice(0, 8)
      .map(e => ({
        time: fmtTime(e.startedAt),
        ok: e.status === 'success',
        msg: nameById[String(e.workflowId)] + (e.status === 'success' ? ' finished a run' : e.status === 'running' || e.status === 'waiting' ? ' is working' : ' hit an error')
      }));

    const runsToday = executions.filter(e => isToday(e.startedAt) && nameById[String(e.workflowId)]).length;

    try {
      const clips = await studioClips();
      const ed = bots.find(x => x.name === 'Clip Editor');
      if (ed) { ed.waiting = clips.filter(c => c.status === 'ready').length; ed.approved = clips.filter(c => c.status === 'approved').length; }
    } catch {}

    return {
      businesses: BUSINESSES.map(b => ({ ...b, bots: bots.filter(x => x.biz === b.id) })),
      feed,
      runsToday,
      updatedAt: new Date().toISOString()
    };
}

// ---------- YouTube Studio clip approvals ----------
// Shorts the Clip Editor made sit in the "Studio Clips" n8n data table.
// ready = waiting for your approval, approved = you'll post it, posted / skipped = done.
const STUDIO_TABLE = process.env.STUDIO_TABLE || 'bKAZJ4UiZ82TMgJy';
const STUDIO_PROJECT = process.env.STUDIO_PROJECT || 'syHKEH4AK0RAR8Hz';
let studioCache = null;
async function studioClips(force) {
  if (!force && studioCache && Date.now() - studioCache.at < 20 * 1000) return studioCache.data;
  requireConnection();
  const r = await mcpTool('get_data_table_rows', {
    dataTableId: STUDIO_TABLE, projectId: STUDIO_PROJECT, limit: 60, sortBy: 'rendered_at:desc',
    filter: { type: 'or', filters: [{ columnName: 'status', condition: 'eq', value: 'ready' }, { columnName: 'status', condition: 'eq', value: 'approved' }] }
  });
  const rows = (r.rows || r.data || []).filter(x => x.clip_id && x.video_url);
  const data = rows.map(x => ({
    id: x.clip_id, status: x.status, streamer: x.streamer || '', platform: x.platform || '', hook: x.hook || '',
    title: x.yt_title || '', description: x.description || '', video: x.video_url, duration: x.duration || null,
    made: fmtTime(x.rendered_at), source: x.url || ''
  }));
  studioCache = { at: Date.now(), data };
  return data;
}
async function studioDecide(id, action) {
  const res = await fetch(N8N_BASE_URL + '/webhook/studio-inbox?id=' + encodeURIComponent(id) + '&a=' + encodeURIComponent(action));
  if (!res.ok) throw new Error('n8n did not save that choice (' + res.status + ')');
  studioCache = null;
}

// ---------- Web server ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/setup') {
    if (!CONFIG_FILE || !SETUP_CODE) { res.writeHead(302, { Location: '/' }); return res.end(); }  // always reachable on the server so the token can be updated; still needs the setup code
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(SETUP_HTML); }
    if (req.method === 'POST') {
      const left = lockedFor(clientIp(req));
      if (left) return sendJson(res, 429, { error: `Too many wrong tries. Try again in ${Math.ceil(left / 60000)} min.` });
      let d = {};
      try { d = JSON.parse(await readBody(req)); } catch {}
      if (String(d.code || '').trim().toUpperCase() !== SETUP_CODE.toUpperCase()) { noteFailure(clientIp(req), req); return sendJson(res, 403, { error: 'Setup code is wrong' }); }
      const token = String(d.token || '').trim();
      const password = String(d.password || '');
      if (!token || password.length < 6) return sendJson(res, 400, { error: 'Fill in the token and a password of 6+ characters' });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ n8nMcpToken: token, password }), { mode: 0o600 });
      N8N_MCP_TOKEN = token; PASSWORD = password; mcpSession = null; cityCache = null;
      return sendJson(res, 200, { ok: true });
    }
  }
  if (needsSetup() && (url.pathname === '/' || url.pathname.startsWith('/api/'))) {
    if (url.pathname === '/') { res.writeHead(302, { Location: '/setup' }); return res.end(); }
    return sendJson(res, 503, { error: 'CR3W City is not set up yet. Open /setup.' });
  }
  if (url.pathname.startsWith('/api/')) {
    const ip = clientIp(req), left = lockedFor(ip);
    if (left) return sendJson(res, 429, { error: 'Too many wrong passwords', minutes: Math.ceil(left / 60000) });
    if (!authorized(req)) {
      if (req.headers['x-cr3w-pass'] || req.headers.authorization) noteFailure(ip, req); // an empty first visit doesn't count
      return sendJson(res, 401, { error: 'Wrong or missing password' });
    }
    fails.delete(ip);
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/layout') {
      return sendJson(res, 200, { businesses: BUSINESSES.map(b => ({ ...b, bots: [] })), feed: [], runsToday: 0 });
    }
    if (req.method === 'GET' && url.pathname === '/api/city') {
      return sendJson(res, 200, await cityData());
    }
    if (req.method === 'GET' && url.pathname === '/api/studio/clips') {
      return sendJson(res, 200, { clips: await studioClips(url.searchParams.has('fresh')) });
    }
    const sc = url.pathname.match(/^\/api\/studio\/clips\/([A-Za-z0-9_-]+)\/(approve|decline|posted)$/);
    if (req.method === 'POST' && sc) {
      await studioDecide(sc[1], sc[2]);
      return sendJson(res, 200, { ok: true, clips: await studioClips(true) });
    }
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/(activate|deactivate)$/);
    if (req.method === 'POST' && m) {
      await setActive(decodeURIComponent(m[1]), m[2] === 'activate');
      cityCache = null;
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    const STATIC = { '/manifest.json': 'application/manifest+json', '/sw.js': 'text/javascript', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/lion.png': 'image/png', '/cr3w-wordmark.png': 'image/png' };
    if (req.method === 'GET' && STATIC[url.pathname]) {
      res.writeHead(200, { 'Content-Type': STATIC[url.pathname], 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', url.pathname.slice(1))));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('CR3W City running on port ' + PORT);
  console.log('n8n connection: ' + (N8N_API_KEY ? 'REST API key' : N8N_MCP_TOKEN ? 'MCP token' : 'NOT SET - add N8N_MCP_TOKEN in Secrets'));
  if (!PASSWORD) console.log('Warning: DASHBOARD_PASSWORD is not set. Anyone with the link can open the city.');
});

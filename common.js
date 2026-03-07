// ============================================================
// FUWU.FR — common.js
// Supabase 连接、认证、通用工具（所有页面共用）
// ============================================================

const SUPABASE_URL = 'https://xwcnbgapjkgbtpgfyjeb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3Y25iZ2FwamtnYnRwZ2Z5amViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MDkyMjQsImV4cCI6MjA4Nzk4NTIyNH0.5H9i2BsTFH3UmDFdOnHRnAkF4eVwDExAaXHait4RFbI';
const SUPABASE_PUB_KEY = 'sb_publishable_Ha0c3gxGVjG-_dLv6qehlw_y69_oN9B';
// _fuwuApiKey: which key to use for apikey header (pages can override before calling auth)
let _fuwuApiKey = SUPABASE_ANON_KEY;

// ── Token state ──────────────────────────────────────────────
let _fuwuAccessToken = null;

function fuwuGetToken() { return _fuwuAccessToken; }
function fuwuSetToken(t) { _fuwuAccessToken = t; }

// ── Headers ──────────────────────────────────────────────────
// H  = minimal (for PATCH/DELETE)
// HR = return=representation (for POST/PATCH needing response)
// HA = anon-only (no auth token, for public endpoints like inscription)

function fuwuHeaders(prefer) {
  const token = _fuwuAccessToken || SUPABASE_ANON_KEY;
  return {
    'apikey': _fuwuApiKey,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Prefer': prefer || 'return=minimal'
  };
}
function fuwuH()  { return fuwuHeaders('return=minimal'); }
function fuwuHR() { return fuwuHeaders('return=representation'); }
function fuwuHA() {
  return {
    'apikey': _fuwuApiKey,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

// ── Auth: login via Supabase Auth ────────────────────────────
async function fuwuAuthLogin(email, password) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': _fuwuApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    return { ok: false, error: data.error_description || data.msg || 'Identifiants incorrects.' };
  }
  _fuwuAccessToken = data.access_token;
  return { ok: true, data };
}

// ── Auth: refresh token ──────────────────────────────────────
async function fuwuAuthRefresh(refreshToken) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'apikey': _fuwuApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    return { ok: false };
  }
  _fuwuAccessToken = data.access_token;
  return { ok: true, data };
}

// ── Auth: logout ─────────────────────────────────────────────
async function fuwuAuthLogout() {
  if (_fuwuAccessToken) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { 'apikey': _fuwuApiKey, 'Authorization': `Bearer ${_fuwuAccessToken}` }
      });
    } catch (e) { /* ignore */ }
  }
  _fuwuAccessToken = null;
}

// ── Session persistence ──────────────────────────────────────
function fuwuSaveSession(key, obj) {
  localStorage.setItem(key, JSON.stringify(obj));
}
function fuwuLoadSession(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}
function fuwuClearSession(key) {
  localStorage.removeItem(key);
}

// ── Auto-refresh timer ───────────────────────────────────────
let _fuwuRefreshInterval = null;
function fuwuStartTokenRefresh(sessionKey, intervalMs) {
  if (_fuwuRefreshInterval) clearInterval(_fuwuRefreshInterval);
  _fuwuRefreshInterval = setInterval(async () => {
    const saved = fuwuLoadSession(sessionKey);
    if (!saved || !saved.refresh_token) return;
    const res = await fuwuAuthRefresh(saved.refresh_token);
    if (res.ok) {
      saved.access_token = res.data.access_token;
      saved.refresh_token = res.data.refresh_token;
      saved.expires_at = Date.now() + res.data.expires_in * 1000;
      fuwuSaveSession(sessionKey, saved);
    }
  }, intervalMs || 45 * 60 * 1000);
}

// ── Fetch with pagination (fetchAll) ─────────────────────────
async function fuwuFetchAll(url, headers) {
  const h = headers || fuwuH();
  let all = [], offset = 0;
  while (true) {
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(`${url}${sep}limit=1000&offset=${offset}`, {
      headers: { ...h, 'Prefer': 'count=none' }
    });
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return all;
}

// ── REST shortcuts ───────────────────────────────────────────
async function fuwuGet(path, headers) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers || fuwuH() });
  return r.json();
}
async function fuwuPost(path, body, headers) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST', headers: headers || fuwuHR(), body: JSON.stringify(body)
  });
  return r;
}
async function fuwuPatch(path, body, headers) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: headers || fuwuH(), body: JSON.stringify(body)
  });
  return r;
}
async function fuwuDelete(path, headers) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE', headers: headers || fuwuH()
  });
  return r;
}
async function fuwuRpc(fn, body, headers) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: headers || fuwuHR(), body: JSON.stringify(body)
  });
  return r;
}

// ── Resolve login → email ────────────────────────────────────
// Used by intermediaire and agent login (login field → email lookup)
async function fuwuResolveEmail(raw, roleFilter) {
  if (raw.includes('@')) return raw;
  try {
    const filter = roleFilter || 'est_intermediaire=eq.true';
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/personnes?login=eq.${encodeURIComponent(raw)}&${filter}&select=email&limit=1`,
      { headers: fuwuHA() }
    );
    const d = await r.json();
    if (d && d.length > 0 && d[0].email) return d[0].email;
  } catch (e) { /* ignore */ }
  return raw.includes('@') ? raw : raw + '@aaaww.top';
}

// ── UI helpers ───────────────────────────────────────────────
function fuwuTogglePwd(inputId, eyeId) {
  const inp = document.getElementById(inputId || 'login-password');
  const eye = document.getElementById(eyeId || 'pwd-eye');
  if (inp.type === 'password') { inp.type = 'text'; eye.textContent = '🙈'; }
  else { inp.type = 'password'; eye.textContent = '👁'; }
}

function fuwuFormatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fuwuFormatDateTime(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// Commission: montant=HT, TTC=HT×1.2, CNY=TTC×8
function fuwuCommTTC(montantHT) { return (parseFloat(montantHT) || 0) * 1.2; }
function fuwuCommCNY(montantHT) { return fuwuCommTTC(montantHT) * 8; }

// Debounce
function fuwuDebounce(fn, ms) {
  let t;
  return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms || 300); };
}

// ── Status labels & colors ───────────────────────────────────
const FUWU_STATUS = {
  en_attente:    { label: 'En attente',    color: '#f59e0b' },
  en_traitement: { label: 'En traitement', color: '#3b82f6' },
  actif:         { label: 'Actif',         color: '#10b981' },
  annule:        { label: 'Annulé',        color: '#ef4444' },
  refuse:        { label: 'Refusé',        color: '#ef4444' },
  termine:       { label: 'Terminé',       color: '#6b7280' }
};

function fuwuStatusBadge(status) {
  const s = FUWU_STATUS[status] || { label: status || '—', color: '#6b7280' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${s.color}22;color:${s.color}">${s.label}</span>`;
}

// ── Service labels ───────────────────────────────────────────
const FUWU_SERVICES = {
  energie:       '⚡ Énergie',
  demenagement:  '📦 Déménagement',
  resiliation:   '❌ Résiliation',
  box_internet:  '📡 Box Internet',
  assurance:     '🛡️ Assurance',
  banque:        '🏦 Banque',
  autre:         '📋 Autre'
};
function fuwuServiceLabel(id) { return FUWU_SERVICES[id] || id || '—'; }

// ═══════════════════════════════════════════════════════════════
// FUWU.FR — common.js v2
// Supabase 连接、认证、统一请求封装、错误监控
// 向后完全兼容 v1 的所有函数签名
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = 'https://xwcnbgapjkgbtpgfyjeb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3Y25iZ2FwamtnYnRwZ2Z5amViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MDkyMjQsImV4cCI6MjA4Nzk4NTIyNH0.5H9i2BsTFH3UmDFdOnHRnAkF4eVwDExAaXHait4RFbI';
const SUPABASE_PUB_KEY = 'sb_publishable_Ha0c3gxGVjG-_dLv6qehlw_y69_oN9B';

// _fuwuApiKey: pages can override before calling auth (client uses PUB_KEY)
var _fuwuApiKey = SUPABASE_ANON_KEY;

// ── Token state ──
let _fuwuAccessToken = null;
let _fuwuUserEmail = null;   // set after login for monitoring context

function fuwuGetToken() { return _fuwuAccessToken; }
function fuwuSetToken(t) { _fuwuAccessToken = t; }

// ═══════════════════════════════════════════════════════════════
// HEADERS
// ═══════════════════════════════════════════════════════════════

function fuwuHeaders(prefer) {
  const token = _fuwuAccessToken || SUPABASE_ANON_KEY;
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Prefer': prefer || 'return=minimal'
  };
}
function fuwuH()  { return fuwuHeaders('return=minimal'); }
function fuwuHR() { return fuwuHeaders('return=representation'); }
function fuwuHA() {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED FETCH — 监控、错误上报、保存失败弹窗
// 替换全局 fetch，所有现有代码自动经过监控
// ═══════════════════════════════════════════════════════════════

const _origFetch = window.fetch.bind(window);
let _fuwuReqCount = 0;
let _fuwuErrCount = 0;
const _fuwuErrWindow = [];
let _fuwuAlertThrottle = {};  // category → last report timestamp

// 覆盖全局 fetch
window.fetch = async function(url, options) {
  // 非 Supabase 请求（如 Google Fonts）直接放行
  if (typeof url === 'string' && !url.includes(SUPABASE_URL)) {
    return _origFetch(url, options);
  }

  _fuwuReqCount++;
  const t0 = Date.now();
  const method = (options && options.method) || 'GET';

  try {
    const r = await _origFetch(url, options);
    const elapsed = Date.now() - t0;

    // 慢请求 > 10s → P3
    if (elapsed > 10000) {
      _fuwuReport('slow_request', 'P3', 'API请求超过10秒: ' + method + ' ' + elapsed + 'ms', {
        url: String(url).substring(0, 200), elapsed_ms: elapsed, status: r.status
      });
    }

    // 非 2xx
    if (!r.ok) {
      _fuwuErrCount++;

      // 写操作失败 → 红色弹窗
      if (method === 'PATCH' || method === 'POST' || method === 'DELETE') {
        // clone 读取 body 不影响原 response
        r.clone().text().then(function(bodyText) {
          _fuwuShowSaveError(r.status, bodyText, method);
        }).catch(function() {});
      }

      // 错误频率追踪
      var now = Date.now();
      _fuwuErrWindow.push(now);
      while (_fuwuErrWindow.length && _fuwuErrWindow[0] < now - 300000) {
        _fuwuErrWindow.shift();
      }

      // 5 分钟内 > 10 个错误 → P2
      if (_fuwuErrWindow.length > 10) {
        _fuwuReport('error_spike', 'P2',
          '5分钟内' + _fuwuErrWindow.length + '个API错误',
          { last_url: String(url).substring(0, 200), last_status: r.status }
        );
        _fuwuErrWindow.length = 0;
      }

      // 401/403 → 认证问题（非登录请求）
      if ((r.status === 401 || r.status === 403) && !String(url).includes('/auth/v1/token')) {
        _fuwuReport('auth_error', 'P2', '认证错误 ' + r.status, {
          url: String(url).substring(0, 200), method: method
        });
      }
    }

    return r;
  } catch (e) {
    // 网络完全不通 → P1
    _fuwuReport('network_error', 'P1', '网络请求失败: ' + e.message, {
      url: String(url).substring(0, 200), method: method
    });
    throw e;
  }
};

// ═══════════════════════════════════════════════════════════════
// ERROR MONITORING
// ═══════════════════════════════════════════════════════════════

// 全局 JS 错误捕获
window.onerror = function(msg, source, line, col, error) {
  _fuwuReport('js_crash', 'P2', String(msg).substring(0, 200), {
    source: source, line: line, column: col,
    stack: error && error.stack ? error.stack.substring(0, 500) : ''
  });
  return false;
};

// 未处理的 Promise 拒绝
window.addEventListener('unhandledrejection', function(event) {
  _fuwuReport('promise_rejection', 'P2', String(event.reason).substring(0, 300), {});
});

/**
 * 写入 system_alerts 表（静默，不影响业务）
 * 同类告警 60 秒内最多报一次
 */
function _fuwuReport(category, severity, message, context) {
  // 节流：同类告警 60s 内只报一次
  var key = category + ':' + severity;
  var now = Date.now();
  if (_fuwuAlertThrottle[key] && now - _fuwuAlertThrottle[key] < 60000) return;
  _fuwuAlertThrottle[key] = now;

  try {
    _origFetch(SUPABASE_URL + '/rest/v1/system_alerts', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        severity: severity,
        category: category,
        message: String(message).substring(0, 500),
        context: JSON.stringify(context || {}),
        source_page: location.pathname.split('/').pop() || 'unknown',
        user_email: _fuwuUserEmail || null
      })
    }).catch(function() {}); // 完全静默
  } catch (e) { /* ignore */ }
}

/** 手动触发告警（给业务代码使用） */
function fuwuAlert(category, severity, message, context) {
  _fuwuReport(category, severity || 'P3', message, context);
}

/**
 * 保存失败红色弹窗（顶部滑入）
 */
function _fuwuShowSaveError(status, body, method) {
  var msg = (method || 'API') + ' 失败 (' + status + ')';
  if (body) {
    try {
      var parsed = JSON.parse(body);
      msg += ': ' + (parsed.message || parsed.hint || parsed.details || '').substring(0, 100);
    } catch (e) {
      msg += ': ' + String(body).substring(0, 100);
    }
  }

  var bar = document.getElementById('fuwu-save-error-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fuwu-save-error-bar';
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#dc3545;color:#fff;padding:12px 20px;font-size:13px;font-weight:600;' +
      'text-align:center;box-shadow:0 2px 12px rgba(220,53,69,0.4);cursor:pointer;' +
      'font-family:DM Sans,system-ui,sans-serif;' +
      'transform:translateY(-100%);transition:transform 0.3s ease;';
    bar.onclick = function() { bar.style.transform = 'translateY(-100%)'; };
    document.body.appendChild(bar);
  }
  bar.textContent = '⚠️ ' + msg + '  (点击关闭)';
  bar.style.transform = 'translateY(0)';
  clearTimeout(bar._timer);
  bar._timer = setTimeout(function() { bar.style.transform = 'translateY(-100%)'; }, 8000);
}

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

async function fuwuAuthLogin(email, password) {
  const r = await _origFetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'apikey': _fuwuApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password })
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    return { ok: false, error: data.error_description || data.msg || 'Identifiants incorrects.' };
  }
  _fuwuAccessToken = data.access_token;
  _fuwuUserEmail = email;
  return { ok: true, data: data };
}

async function fuwuAuthRefresh(refreshToken) {
  const r = await _origFetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { 'apikey': _fuwuApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) {
    return { ok: false };
  }
  _fuwuAccessToken = data.access_token;
  return { ok: true, data: data };
}

async function fuwuAuthLogout() {
  if (_fuwuAccessToken) {
    try {
      await _origFetch(SUPABASE_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'apikey': _fuwuApiKey, 'Authorization': 'Bearer ' + _fuwuAccessToken }
      });
    } catch (e) { /* ignore */ }
  }
  _fuwuAccessToken = null;
  _fuwuUserEmail = null;
}

// ── Session persistence ──
function fuwuSaveSession(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
}
function fuwuLoadSession(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}
function fuwuClearSession(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

// ── Auto-refresh timer ──
let _fuwuRefreshInterval = null;
function fuwuStartTokenRefresh(sessionKey, intervalMs) {
  if (_fuwuRefreshInterval) clearInterval(_fuwuRefreshInterval);
  _fuwuRefreshInterval = setInterval(async function() {
    const saved = fuwuLoadSession(sessionKey);
    if (!saved || !saved.refresh_token) return;
    const res = await fuwuAuthRefresh(saved.refresh_token);
    if (res.ok) {
      saved.access_token = res.data.access_token;
      saved.refresh_token = res.data.refresh_token;
      saved.expires_at = Date.now() + res.data.expires_in * 1000;
      fuwuSaveSession(sessionKey, saved);
      _fuwuAccessToken = saved.access_token;
    }
  }, intervalMs || 45 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════
// FETCH HELPERS (v1 backward compatible)
// ═══════════════════════════════════════════════════════════════

async function fuwuFetchAll(url, headers) {
  const h = headers || fuwuH();
  var all = [], offset = 0;
  while (true) {
    var sep = url.includes('?') ? '&' : '?';
    var r = await fetch(url + sep + 'limit=1000&offset=' + offset, {
      headers: Object.assign({}, h, { 'Prefer': 'count=none' })
    });
    if (!r.ok) break;
    var batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return all;
}

async function fuwuGet(path, headers) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: headers || fuwuH() });
  return r.json();
}
async function fuwuPost(path, body, headers) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'POST', headers: headers || fuwuHR(), body: JSON.stringify(body)
  });
}
async function fuwuPatch(path, body, headers) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'PATCH', headers: headers || fuwuH(), body: JSON.stringify(body)
  });
}
async function fuwuDelete(path, headers) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'DELETE', headers: headers || fuwuH()
  });
}
async function fuwuRpc(fn, body, headers) {
  return fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: headers || fuwuHR(), body: JSON.stringify(body)
  });
}

/**
 * 批量按 ID 加载关联数据
 * @param {string} table   表名
 * @param {string} select  字段列表
 * @param {Array}  ids     ID 数组
 * @param {object} map     写入目标 map
 * @param {number} batch   每批大小，默认 200
 */
async function fuwuBatchLoad(table, select, ids, map, batch) {
  batch = batch || 200;
  var unique = [...new Set(ids.filter(Boolean))];
  for (var i = 0; i < unique.length; i += batch) {
    var chunk = unique.slice(i, i + batch);
    try {
      var r = await fetch(
        SUPABASE_URL + '/rest/v1/' + table + '?id=in.(' + chunk.join(',') + ')&select=' + select,
        { headers: fuwuH() }
      );
      var d = await r.json();
      if (Array.isArray(d)) d.forEach(function(item) { map[item.id] = item; });
    } catch (e) { /* continue */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// RESOLVE LOGIN → EMAIL
// ═══════════════════════════════════════════════════════════════

async function fuwuResolveEmail(raw, roleFilter) {
  if (raw.includes('@')) return raw;
  try {
    var filter = roleFilter || 'est_intermediaire=eq.true';
    var r = await fetch(
      SUPABASE_URL + '/rest/v1/personnes?login=eq.' + encodeURIComponent(raw) +
      '&' + filter + '&select=email&limit=1',
      { headers: fuwuHA() }
    );
    var d = await r.json();
    if (d && d.length > 0 && d[0].email) return d[0].email;
  } catch (e) { /* ignore */ }
  return raw.includes('@') ? raw : raw + '@aaaww.top';
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════

function fuwuTogglePwd(inputId, eyeId) {
  var inp = document.getElementById(inputId || 'login-password');
  var eye = document.getElementById(eyeId || 'pwd-eye');
  if (!inp) return;
  if (inp.type === 'password') { inp.type = 'text'; if (eye) eye.textContent = '🙈'; }
  else { inp.type = 'password'; if (eye) eye.textContent = '👁'; }
}

function fuwuFormatDate(d) {
  if (!d) return '—';
  var dt = new Date(d);
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fuwuFormatDateTime(d) {
  if (!d) return '—';
  var dt = new Date(d);
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function fuwuCommTTC(montantHT) { return (parseFloat(montantHT) || 0) * 1.2; }
function fuwuCommCNY(montantHT) { return fuwuCommTTC(montantHT) * 8; }

function fuwuDebounce(fn, ms) {
  var t;
  return function() {
    var args = arguments, self = this;
    clearTimeout(t);
    t = setTimeout(function() { fn.apply(self, args); }, ms || 300);
  };
}

// ── Status labels & colors ──
var FUWU_STATUS = {
  en_attente:    { label: 'En attente',    color: '#f59e0b' },
  en_traitement: { label: 'En traitement', color: '#3b82f6' },
  actif:         { label: 'Actif',         color: '#10b981' },
  annule:        { label: 'Annulé',        color: '#ef4444' },
  refuse:        { label: 'Refusé',        color: '#ef4444' },
  termine:       { label: 'Terminé',       color: '#6b7280' }
};

function fuwuStatusBadge(status) {
  var s = FUWU_STATUS[status] || { label: status || '—', color: '#6b7280' };
  return '<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:' + s.color + '22;color:' + s.color + '">' + s.label + '</span>';
}

var FUWU_SERVICES = {
  energie:       '⚡ Énergie',
  demenagement:  '📦 Déménagement',
  resiliation:   '❌ Résiliation',
  box_internet:  '📡 Box Internet',
  assurance:     '🛡️ Assurance',
  banque:        '🏦 Banque',
  autre:         '📋 Autre'
};
function fuwuServiceLabel(id) { return FUWU_SERVICES[id] || id || '—'; }

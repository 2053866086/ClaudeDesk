/*
 * ClaudeDesk 本地服务
 *   node server.js              启动后打开 http://127.0.0.1:17860/
 *   双击 launch.vbs             后台启动服务并用 Edge/Chrome 应用窗口打开（桌面快捷方式就是它）
 *
 * 只监听 127.0.0.1。API Key 只在这个进程里使用，不会下发给浏览器。
 * 连接配置的优先级：config.json > ~/.claude/settings.json 里的 env > 环境变量
 *   config.json 可选字段：baseUrl / authToken / apiKey / customHeaders / defaultModel / titleModel
 * 所有窗口关闭约 3 分钟后自动退出；设 CLAUDEDESK_NO_IDLE=1 可关闭这个行为。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const { createImporter } = require('./importer');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const CONV_DIR = path.join(DATA, 'conversations');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const PORT = Number(process.env.CLAUDEDESK_PORT) || 17860;
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map(h => `http://${h}`));
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const IDLE_MS = 3 * 60e3;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'";
const DEFAULT_SETTINGS = { systemPrompt: '', defaultModel: '', maxTokens: 16000, thinking: false, thinkingBudget: 8000, effort: '', theme: 'system', autoImport: true };
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const IMPORT_EVERY_MS = 5 * 60e3;
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ---------- 配置 ----------

function readJsonFile(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function parseHeaders(s) {
  const h = {};
  for (const line of String(s || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

// 每次请求都重新读，改了 Key 或中转地址不用重启
function loadConfig() {
  const own = readJsonFile(path.join(ROOT, 'config.json'), {});
  const env = readJsonFile(path.join(CLAUDE_HOME, 'settings.json'), {}).env || {};
  const pick = (k, envKey) => own[k] || env[envKey] || process.env[envKey] || '';
  return {
    baseUrl: (pick('baseUrl', 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com').replace(/\/+$/, ''),
    authToken: pick('authToken', 'ANTHROPIC_AUTH_TOKEN'),
    apiKey: pick('apiKey', 'ANTHROPIC_API_KEY'),
    headers: parseHeaders(own.customHeaders ?? env.ANTHROPIC_CUSTOM_HEADERS ?? process.env.ANTHROPIC_CUSTOM_HEADERS),
    defaultModel: pick('defaultModel', 'ANTHROPIC_DEFAULT_OPUS_MODEL') || 'claude-opus-5-5',
    // 这个中转上的 Haiku 首字慢、还不太听系统提示词，起标题用 Sonnet
    titleModel: own.titleModel || env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
    favorites: [own.defaultModel, env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL].filter(Boolean),
  };
}

function upstreamHeaders(c) {
  const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...c.headers };
  if (c.authToken) h.authorization = `Bearer ${c.authToken}`;
  if (c.apiKey) h['x-api-key'] = c.apiKey;
  return h;
}

function upstreamError(status, text) {
  let msg = text;
  try { const j = JSON.parse(text); msg = j.error?.message || j.message || text; } catch { /* 不是 JSON 就原样显示 */ }
  return `中转返回 ${status}：${String(msg || '').slice(0, 500)}`;
}

const hostOf = u => { try { return new URL(u).host; } catch { return u; } };

// ---------- HTTP 工具 ----------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const h = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (type.startsWith('text/html')) h['content-security-policy'] = CSP;
  res.writeHead(status, h);
  res.end(status === 204 ? undefined : data);
}

const fail = (res, status, message) => send(res, status, { error: { message } });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('请求太大'), { status: 413 })); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('JSON 格式不对'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ---------- 对话存储：每个对话一个 JSON 文件，列表信息缓存在内存 ----------

const meta = new Map();
const locks = new Map();
const convPath = id => path.join(CONV_DIR, `${id}.json`);

function metaOf(c) {
  const m = { id: c.id, title: String(c.title || '新对话').slice(0, 200), model: c.model || '', createdAt: c.createdAt || 0, updatedAt: c.updatedAt || 0 };
  if (c.source?.type) m.source = c.source.type;
  return m;
}

async function loadIndex() {
  await fsp.mkdir(CONV_DIR, { recursive: true });
  for (const f of await fsp.readdir(CONV_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const c = JSON.parse(await fsp.readFile(path.join(CONV_DIR, f), 'utf8'));
      if (ID_RE.test(c.id)) meta.set(c.id, metaOf(c));
    } catch (e) { console.warn('跳过损坏的对话文件', f, e.message); }
  }
}

// 同一个对话的写入排队执行
function withLock(id, fn) {
  const next = (locks.get(id) || Promise.resolve()).then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

async function writeAtomic(p, data) {
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, data);
  try { await fsp.rename(tmp, p); } catch { await fsp.writeFile(p, data); await fsp.rm(tmp, { force: true }); }
}

const importer = createImporter({
  projectsDir: path.join(CLAUDE_HOME, 'projects'),
  convDir: CONV_DIR,
  stateFile: path.join(DATA, 'import-state.json'),
  ID_RE, withLock, writeAtomic, meta, metaOf,
});

function autoImportOn() {
  return { ...DEFAULT_SETTINGS, ...readJsonFile(SETTINGS_FILE, {}) }.autoImport;
}

function runImport(force, restore) {
  return importer.run(force, restore).then(r => {
    if (r.added || r.updated || r.errors.length) console.log(`导入 Claude Code 会话：新增 ${r.added}，更新 ${r.updated}，跳过 ${r.skipped}，保留本地修改 ${r.kept}`, r.errors);
    return r;
  });
}

// ---------- 模型列表 ----------

let modelCache = { at: 0, base: '', list: null };

async function listModels(c) {
  if (modelCache.list && modelCache.base === c.baseUrl && Date.now() - modelCache.at < 10 * 60e3) return modelCache.list;
  const r = await fetch(`${c.baseUrl}/v1/models?limit=1000`, { headers: upstreamHeaders(c), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(upstreamError(r.status, await r.text()));
  const j = await r.json();
  // 中转会同时列出 OpenAI 等模型，只留支持 Anthropic 接口的
  const list = (j.data || [])
    .filter(m => !m.supported_endpoint_types || m.supported_endpoint_types.includes('anthropic'))
    .map(m => m.id).filter(Boolean).sort();
  modelCache = { at: Date.now(), base: c.baseUrl, list };
  return list;
}

// ---------- 对话转发 ----------

function cleanMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    const allowed = m.role === 'user' ? ['text', 'image', 'document'] : ['text'];
    let content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    // 历史里的思考块不回传（不调用工具时 API 允许省略），只保留正文、图片和文档
    content = content
      .filter(b => b && allowed.includes(b.type) && !(b.type === 'text' && !String(b.text || '').trim()))
      .map(({ cache_control, ...b }) => b);
    if (!content.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...content);
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  // 最后一个内容块打缓存断点，多轮对话能复用前面的前缀缓存
  const last = out[out.length - 1];
  if (last) last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  return out;
}

const clampInt = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);

let active = 0;

async function chat(req, res) {
  const body = await readBody(req, 120 << 20);
  const c = loadConfig();
  const messages = cleanMessages(body.messages);
  if (!messages.length) return fail(res, 400, '没有可发送的消息');
  const payload = { model: String(body.model || c.defaultModel), max_tokens: clampInt(body.max_tokens, 256, 128000, 16000), stream: true, messages };
  if (body.system && String(body.system).trim()) payload.system = String(body.system);
  if (body.thinking) {
    const budget = clampInt(body.thinking_budget, 1024, 64000, 8000);
    payload.thinking = { type: 'enabled', budget_tokens: budget };
    if (payload.max_tokens <= budget) payload.max_tokens = budget + 4096;
  }

  if (EFFORTS.has(body.effort)) payload.output_config = { effort: body.effort };

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  active++;
  try {
    const call = () => fetch(`${c.baseUrl}/v1/messages`, { method: 'POST', headers: upstreamHeaders(c), body: JSON.stringify(payload), signal: ac.signal });
    let up;
    let dropped = false;
    try {
      up = await call();
      // 有的模型（比如 Haiku）不认 effort 参数，去掉后自动重试一次
      if (!up.ok && payload.output_config) {
        const text = await up.text().catch(() => '');
        if (/effort/i.test(text)) {
          delete payload.output_config;
          dropped = true;
          up = await call();
        } else {
          return fail(res, up.status || 502, upstreamError(up.status, text));
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) fail(res, 502, `连不上 ${hostOf(c.baseUrl)}：${e.cause?.code || e.message}`);
      return;
    }
    if (!up.ok || !up.body) {
      const msg = upstreamError(up.status, await up.text().catch(() => ''));
      return fail(res, up.status || 502, dropped ? `${msg}\n（这个模型不支持推理强度，已去掉强度重试，仍然失败）` : msg);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    if (dropped) res.write(`event: claudedesk\ndata: ${JSON.stringify({ type: 'effort_unsupported' })}\n\n`);
    try {
      for await (const chunk of up.body) res.write(chunk);
    } catch (e) {
      if (!ac.signal.aborted) res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: `连接中断：${e.cause?.code || e.message}` } })}\n\n`);
    }
    res.end();
  } finally {
    active--;
  }
}

async function makeTitle(c, text) {
  const r = await fetch(`${c.baseUrl}/v1/messages`, {
    method: 'POST', headers: upstreamHeaders(c), signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model: c.titleModel, max_tokens: 60,
      system: '你只负责给对话起标题。输出一个不超过 15 个字的标题，语言跟对话一致，不要引号、句号或任何解释。',
      messages: [{ role: 'user', content: `给下面这段对话起一个标题，不超过 15 个字，只输出标题本身，不要回答对话里的问题。\n\n<对话>\n${String(text).slice(0, 3000)}\n</对话>` }],
    }),
  });
  if (!r.ok) throw new Error(upstreamError(r.status, await r.text()));
  const j = await r.json();
  const t = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim().split('\n')[0]
    .replace(/^[#>*\s-]+/, '').replace(/\*\*/g, '').replace(/^(标题[:：]\s*)/, '').replace(/^["'“”《「]+|["'“”》」。.]+$/g, '').trim().slice(0, 40);
  if (!t) throw new Error('标题为空');
  return t;
}

// ---------- 路由 ----------

const clients = new Map();
let lastActivity = Date.now();
const startedAt = Date.now();

async function route(req, res, p) {
  const m = req.method;
  if (p === '/api/ping' && m === 'POST') {
    const b = await readBody(req, 4096);
    clients.set(String(b.id || 'anon'), Date.now());
    return send(res, 200, { ok: true, importVersion: importer.status.version, importing: importer.status.running });
  }
  if (p === '/api/import' && m === 'GET') {
    return send(res, 200, { ...importer.status, enabled: autoImportOn(), dir: path.join(CLAUDE_HOME, 'projects') });
  }
  if (p === '/api/import' && m === 'POST') {
    const b = await readBody(req, 4096);
    const r = await runImport(Boolean(b.force), Boolean(b.restore));
    return send(res, 200, { ...importer.status, result: r });
  }
  if (p === '/api/config' && m === 'GET') {
    const c = loadConfig();
    const beta = String(c.headers['anthropic-beta'] || '');
    return send(res, 200, {
      baseHost: hostOf(c.baseUrl), hasKey: Boolean(c.authToken || c.apiKey), defaultModel: c.defaultModel, titleModel: c.titleModel,
      context1m: /context-1m/.test(beta),
    });
  }
  if (p === '/api/models' && m === 'GET') {
    const c = loadConfig();
    let list = [];
    let error = null;
    try { list = await listModels(c); } catch (e) { error = e.message; }
    const favorites = [...new Set([c.defaultModel, ...c.favorites])];
    return send(res, 200, { models: [...new Set([...favorites, ...list])], favorites, error });
  }
  if (p === '/api/settings') {
    const cur = { ...DEFAULT_SETTINGS, ...readJsonFile(SETTINGS_FILE, {}) };
    if (m === 'GET') return send(res, 200, cur);
    if (m === 'PUT') {
      const b = await readBody(req, 1 << 20);
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in b && typeof b[k] === typeof DEFAULT_SETTINGS[k]) cur[k] = b[k];
      cur.maxTokens = clampInt(cur.maxTokens, 256, 128000, 16000);
      cur.thinkingBudget = clampInt(cur.thinkingBudget, 1024, 64000, 8000);
      if (cur.effort && !EFFORTS.has(cur.effort)) cur.effort = '';
      const was = autoImportOn();
      await writeAtomic(SETTINGS_FILE, JSON.stringify(cur, null, 2));
      if (cur.autoImport && !was) runImport(false).catch(e => console.warn('导入失败', e.message));
      return send(res, 200, cur);
    }
  }
  if (p === '/api/conversations' && m === 'GET') return send(res, 200, [...meta.values()].sort((a, b) => b.updatedAt - a.updatedAt));
  const cm = p.match(/^\/api\/conversations\/([^/]+)$/);
  if (cm) {
    const id = cm[1];
    if (!ID_RE.test(id)) return fail(res, 400, '对话 ID 不合法');
    if (m === 'GET') {
      try { return send(res, 200, await fsp.readFile(convPath(id), 'utf8')); } catch { return fail(res, 404, '对话不存在'); }
    }
    if (m === 'PUT') {
      const b = await readBody(req, 200 << 20);
      if (b.id !== id || !Array.isArray(b.messages)) return fail(res, 400, '对话数据不完整');
      b.updatedAt = Date.now();
      // 导入的对话在这里改过就不再被导入覆盖
      if (b.source) b.localEdits = true;
      await withLock(id, () => writeAtomic(convPath(id), JSON.stringify(b)));
      meta.set(id, metaOf(b));
      return send(res, 200, metaOf(b));
    }
    if (m === 'DELETE') {
      await withLock(id, () => fsp.rm(convPath(id), { force: true }));
      meta.delete(id);
      await importer.forget(id);
      return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/chat' && m === 'POST') return chat(req, res);
  if (p === '/api/title' && m === 'POST') {
    const b = await readBody(req, 1 << 20);
    try { return send(res, 200, { title: await makeTitle(loadConfig(), b.text || '') }); } catch (e) { return fail(res, 502, e.message); }
  }
  return fail(res, 404, '接口不存在');
}

async function serveStatic(res, p) {
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.resolve(PUB, rel);
  if (!file.startsWith(PUB + path.sep)) return fail(res, 403, 'forbidden');
  try {
    send(res, 200, await fsp.readFile(file), MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch { fail(res, 404, 'not found'); }
}

const server = http.createServer(async (req, res) => {
  try {
    // Host 和 Origin 校验挡住 DNS 重绑定和其他网页的跨站请求
    if (!HOSTS.has(req.headers.host || '')) return fail(res, 403, 'forbidden host');
    if (req.headers.origin && !ORIGINS.has(req.headers.origin)) return fail(res, 403, 'forbidden origin');
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    if (p.startsWith('/api/')) {
      lastActivity = Date.now();
      if (p === '/api/health') return send(res, 200, { app: 'claudedesk', pid: process.pid });
      if (p === '/api/bye' && req.method === 'POST') {
        const b = await readBody(req, 4096).catch(() => ({}));
        clients.delete(String(b.id));
        return send(res, 204, '');
      }
      if (req.headers['x-claudedesk'] !== '1') return fail(res, 403, 'missing header');
      return await route(req, res, p);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
    return await serveStatic(res, p);
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.message);
    else res.end();
  }
});

if (!process.env.CLAUDEDESK_NO_IDLE) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, t] of clients) if (now - t > IDLE_MS) clients.delete(id);
    if (!clients.size && !active && !importer.status.running && now - startedAt > 90e3 && now - lastActivity > 15e3) {
      console.log('没有打开的窗口，退出');
      process.exit(0);
    }
  }, 5000).unref();
}

(async () => {
  await fsp.mkdir(DATA, { recursive: true });
  await loadIndex();
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') { console.error(`端口 ${PORT} 已被占用`); process.exit(1); }
    throw e;
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`ClaudeDesk: http://127.0.0.1:${PORT}/  已有对话 ${meta.size} 个`);
    const tick = () => { if (autoImportOn()) runImport(false).catch(e => console.warn('导入失败', e.message)); };
    tick();
    setInterval(tick, IMPORT_EVERY_MS).unref();
  });
})();

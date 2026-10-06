/* ClaudeDesk 前端：对话列表、流式渲染、附件、设置。所有请求都发给本地服务，浏览器拿不到 API Key。 */
'use strict';
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 隐私模式下没有 localStorage */ } };
const CLIENT_ID = uid();

const ICON = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
  regen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
};
const STOP_NOTE = {
  max_tokens: '回复达到最大输出长度，被截断了。可以在设置里调大"最大输出 token"。',
  user_stop: '已停止生成。',
  refusal: '模型拒绝回答这个请求。',
};

const state = {
  settings: { theme: 'system', maxTokens: 16000, thinking: false, thinkingBudget: 8000, systemPrompt: '', defaultModel: '' },
  config: {},
  models: [],
  favorites: [],
  list: [],               // 侧栏里的对话摘要
  cache: new Map(),       // 已打开过的完整对话
  conv: null,             // 当前对话
  pending: [],            // 输入框里待发送的附件
  streams: new Map(),     // 正在生成的回复：消息 id -> { ac, conv }
  edit: null,             // 正在编辑的消息：{ conv, index }
};

// ---------- 接口 ----------

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'x-claudedesk': '1' }, signal: opts.signal };
  if (opts.text !== undefined || opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = opts.text !== undefined ? opts.text : JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  if (opts.raw) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

const friendly = e => (/Failed to fetch|NetworkError/i.test(e.message) ? '连不上本地服务，ClaudeDesk 可能已经退出了，请重新打开。' : e.message);

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- Markdown ----------

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
      return `<div class="code"><div class="code-head"><span>${esc(l || 'text')}</span><button type="button" class="copy-code">${ICON.copy}<span>复制</span></button></div>`
        + `<pre><code${l ? ` class="language-${esc(l)}"` : ''}>${esc(text)}</code></pre></div>`;
    },
  },
});
DOMPurify.addHook('afterSanitizeAttributes', n => {
  if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
});
hljs.configure({ ignoreUnescapedHTML: true });
const md = s => DOMPurify.sanitize(marked.parse(s || ''));

function highlightIn(node) {
  node.querySelectorAll('pre code').forEach(c => {
    if (c.textContent.length < 60000) try { hljs.highlightElement(c); } catch { /* 不认识的语言就不着色 */ }
  });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = ICON.check + (btn.classList.contains('copy-code') ? '<span>已复制</span>' : '');
    setTimeout(() => (btn.innerHTML = orig), 1500);
  }
}

function iconBtn(icon, label, fn, cls) {
  const b = el('button', cls);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = ICON[icon];
  b.onclick = () => fn(b);
  return b;
}

const fmtSize = n => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function fileChip(f) {
  const c = el('div', 'chip');
  c.title = f.name;
  c.append(el('span', null, f.name), el('small', null, `${f.kind === 'pdf' ? 'PDF' : '文本'} · ${fmtSize(f.size || 0)}`));
  return c;
}

const fileImg = f => Object.assign(new Image(), { src: `data:${f.mediaType};base64,${f.data}`, alt: f.name, title: f.name });

// ---------- 消息渲染 ----------

const convLive = c => [...state.streams.values()].some(s => s.conv === c);

function setTitle(c) {
  const t = c && c.messages.length ? c.title : '';
  $('#conv-title').textContent = t;
  document.title = t ? `${t} - ClaudeDesk` : 'ClaudeDesk';
}

function renderConv() {
  const c = state.conv;
  const box = $('#messages');
  box.textContent = '';
  $('#main').classList.toggle('empty', !c.messages.length);
  if (c.source?.type === 'claude-code') box.append(importBanner(c));
  for (const m of c.messages) box.append(m.role === 'user' ? userNode(c, m) : asstNode(c, m));
  setTitle(c);
  renderUsage();
  box.scrollTop = box.scrollHeight;
}

function userNode(c, m) {
  const n = el('div', 'msg user');
  n.dataset.id = m.id;
  if (m.files?.length) {
    const f = el('div', 'files');
    for (const x of m.files) f.append(x.kind === 'image' ? fileImg(x) : fileChip(x));
    n.append(f);
  }
  if (m.text) n.append(el('div', 'bubble', m.text));
  const foot = el('div', 'msg-foot');
  if (m.text) foot.append(iconBtn('copy', '复制', b => copyText(m.text, b)));
  foot.append(iconBtn('edit', '编辑', () => startEdit(c, m)));
  n.append(foot);
  return n;
}

function asstNode(c, m) {
  const n = el('div', 'msg assistant');
  n.dataset.id = m.id;
  n.append(el('div', 'blocks'));
  fillAsst(n, c, m);
  return n;
}

function makeBlock(kind, m, i) {
  if (kind === 'think') {
    const d = el('details', 'think');
    const s = el('summary');
    s.append(el('span', null, '思考中…'));
    d.append(s, el('div', 'think-body prose'));
    // 只记录用户手动展开或收起的状态，程序设置的不算
    d.addEventListener('toggle', () => { if (d.open !== d._want) (m._open ||= {})[i] = d.open; });
    d.dataset.kind = kind;
    return d;
  }
  if (kind === 'tool') {
    const d = el('details', 'tool');
    d.dataset.kind = kind;
    return d;
  }
  const n = el('div', kind === 'text' ? 'prose' : null);
  n.dataset.kind = kind;
  n.hidden = kind === 'skip';
  return n;
}

// 导入的 Claude Code 工具调用：一行摘要，展开看参数和结果。内容按纯文本显示，不当 Markdown 解析
function fillTool(d, b) {
  d.textContent = '';
  d.classList.toggle('err', Boolean(b.error));
  const s = el('summary');
  s.append(el('b', null, b.name), el('span', null, b.desc || ''));
  d.append(s);
  const body = el('div', 'tool-body');
  if (b.input) body.append(el('div', 'tool-label', '参数'), el('pre', null, b.input));
  body.append(el('div', 'tool-label', b.error ? '出错' : '结果'), el('pre', null, b.result || '（无输出）'));
  d.append(body);
}

function importBanner(c) {
  const s = c.source;
  const b = el('div', 'import-banner');
  const where = s.cwd ? `目录 ${s.cwd}` : `项目 ${s.project}`;
  b.append(el('span', null, `从 Claude Code 导入 · ${where} · 会话 ${s.sessionId.slice(0, 8)}`));
  const cmd = `cd "${s.cwd || '~'}"; claude --resume ${s.sessionId}`;
  const btn = el('button', null, '复制续聊命令');
  btn.type = 'button';
  btn.title = `在终端里粘贴运行，回到 Claude Code 带工具继续：${cmd}`;
  btn.onclick = () => { copyText(cmd); toast('已复制，粘贴到终端运行即可回到 Claude Code 继续'); };
  b.append(btn, el('small', null, c.localEdits ? '已在这里继续过，不再自动同步。' : '在这里继续是普通聊天，模型用不了工具；源会话有新内容会自动同步。'));
  return b;
}

function paintBlocks(box, m, live) {
  const blocks = m.blocks || [];
  while (box.children.length > blocks.length) box.lastChild.remove();
  blocks.forEach((b, i) => {
    const kind = b?.type === 'thinking' ? 'think' : b?.type === 'text' ? 'text' : b?.type === 'tool' ? 'tool' : 'skip';
    let n = box.children[i];
    if (!n || n.dataset.kind !== kind) {
      const f = makeBlock(kind, m, i);
      if (n) n.replaceWith(f); else box.append(f);
      n = f;
    }
    if (kind === 'skip') return;
    const isLive = live && !b.done;
    const key = `${(b.text || b.result || '').length}|${isLive}`;
    if (n._key === key) return;
    n._key = key;
    if (kind === 'tool') {
      fillTool(n, b);
    } else if (kind === 'think') {
      n.classList.toggle('live', isLive);
      n.hidden = !isLive && !b.text.trim();
      n.querySelector('summary span').textContent = isLive ? '思考中…' : '思考过程';
      n.querySelector('.think-body').innerHTML = md(b.text);
      const want = m._open?.[i] ?? isLive;
      n._want = want;
      n.open = want;
    } else {
      n.innerHTML = md(b.text);
      if (!isLive) highlightIn(n);
      else if (i === blocks.length - 1) n.lastElementChild?.classList.add('cursor');
    }
  });
}

const EFFORT_LABEL = { low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
const fmtTok = n => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : n.toLocaleString());

// 一条回复的用量。导入的 Claude Code 回合可能包含多次调用，用 usageTotal；自己发的是一次调用，用 usage
function usageOf(m) {
  if (m.usageTotal) return m.usageTotal;
  const u = m.usage;
  if (!u) return null;
  return { input: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, output: u.output_tokens || 0, calls: 1 };
}

// 最后一次调用的上下文大小：输入（含缓存）加输出，下一轮至少要带这么多
function contextOf(m) {
  const u = m?.usage;
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
}

function metaText(m) {
  const parts = [m.model];
  if (m.effort) parts.push(`强度 ${EFFORT_LABEL[m.effort] || m.effort}`);
  const t = usageOf(m);
  if (t) {
    const input = t.input + t.cacheRead + t.cacheWrite;
    if (input) parts.push(`输入 ${fmtTok(input)}${t.cacheRead ? `（缓存命中 ${fmtTok(t.cacheRead)}）` : ''}`);
    if (t.output) parts.push(`输出 ${fmtTok(t.output)}`);
    if (t.calls > 1) parts.push(`${t.calls} 次调用`);
  }
  return parts.filter(Boolean).join(' · ');
}

const windowOf = model => (state.config.context1m && /opus|sonnet/i.test(model || '') ? 1e6 : 2e5);

function convUsage(c) {
  const s = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0, replies: 0 };
  let last = null;
  for (const m of c.messages) {
    if (m.role !== 'assistant') continue;
    const t = usageOf(m);
    if (!t) continue;
    s.replies++;
    s.input += t.input; s.cacheRead += t.cacheRead; s.cacheWrite += t.cacheWrite; s.output += t.output; s.calls += t.calls;
    last = m;
  }
  s.context = contextOf(last);
  s.window = windowOf(last?.model || c.model || $('#model').value);
  return s;
}

function renderUsage() {
  const c = state.conv;
  const btn = $('#usage');
  const s = c ? convUsage(c) : null;
  if (!s || !s.replies) {
    btn.hidden = true;
    closeUsage();
    return;
  }
  const pct = Math.min(100, (s.context / s.window) * 100);
  btn.hidden = false;
  btn.classList.toggle('warn', pct >= 80);
  $('#usage-bar').style.width = `${Math.max(2, pct)}%`;
  $('#usage-text').textContent = `${fmtTok(s.context)} / ${fmtTok(s.window)}`;
  btn.title = `上下文约 ${s.context.toLocaleString()} token，占 ${pct.toFixed(1)}%。点开看整个对话的用量`;
  if (!$('#usage-pop').hidden) fillUsagePop(c, s);
}

function fillUsagePop(c, s) {
  const pct = Math.min(100, (s.context / s.window) * 100);
  const totalIn = s.input + s.cacheRead + s.cacheWrite;
  const pop = $('#usage-pop');
  pop.innerHTML = `<h4>token 用量</h4><dl>
    <dt>回复</dt><dd>${s.replies} 条${s.calls > s.replies ? ` <small>· ${s.calls} 次调用</small>` : ''}</dd>
    <dt>输入合计</dt><dd>${totalIn.toLocaleString()}</dd>
    <dt>　新输入</dt><dd>${s.input.toLocaleString()}</dd>
    <dt>　缓存命中</dt><dd>${s.cacheRead.toLocaleString()}</dd>
    <dt>　写入缓存</dt><dd>${s.cacheWrite.toLocaleString()}</dd>
    <dt>输出合计</dt><dd>${s.output.toLocaleString()}</dd>
    <dt>当前上下文</dt><dd>${s.context.toLocaleString()} <small>/ ${fmtTok(s.window)} · ${pct.toFixed(1)}%</small></dd>
    <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div></dl>
    <p>数字来自中转返回的 usage，按当前对话里保留的回复统计，重新生成掉的不算。缓存命中通常按更低的价格计费。上下文上限是按${state.config.context1m ? '已开启的 1M 上下文' : '标准 200k'}估算的。${c.source ? '导入的会话按 Claude Code 每次调用的记录累加。' : ''}</p>`;
}

function openUsage() {
  const c = state.conv;
  if (!c) return;
  fillUsagePop(c, convUsage(c));
  $('#usage-pop').hidden = false;
  $('#usage').setAttribute('aria-expanded', 'true');
}

function closeUsage() {
  $('#usage-pop').hidden = true;
  $('#usage').setAttribute('aria-expanded', 'false');
}

function fillAsst(n, c, m) {
  const live = state.streams.has(m.id);
  paintBlocks(n.querySelector('.blocks'), m, live);
  const has = (m.blocks || []).some(b => b?.text?.trim());
  const key = [live, has, m.error || '', m.stop || '', m.usage?.output_tokens || 0, m.effortDropped || ''].join('|');
  if (n._key === key) return;
  n._key = key;
  n.querySelectorAll(':scope > .status, :scope > .msg-foot').forEach(x => x.remove());
  if (live) {
    if (!has) {
      const s = el('div', 'status');
      const d = el('div', 'dots');
      d.append(el('i'), el('i'), el('i'));
      s.append(d);
      n.append(s);
    }
    return;
  }
  if (m.error) {
    const s = el('div', 'status');
    const r = el('button', 'btn-retry', '重试');
    r.type = 'button';
    r.onclick = () => regenerate(c);
    s.append(el('div', 'note err', m.error), r);
    n.append(s);
  } else if (STOP_NOTE[m.stop]) {
    n.append(el('div', 'status note', STOP_NOTE[m.stop]));
  }
  if (m.effortDropped) n.append(el('div', 'status note', `${m.model} 不支持推理强度参数，这条按默认强度回答。`));
  const foot = el('div', 'msg-foot');
  const text = (m.blocks || []).filter(b => b?.type === 'text').map(b => b.text).join('\n\n');
  if (text) foot.append(iconBtn('copy', '复制', b => copyText(text, b)));
  foot.append(iconBtn('regen', '重新生成', () => regenerate(c), 'regen'));
  foot.append(el('span', 'meta', metaText(m)));
  n.append(foot);
}

const painting = new Set();

function schedulePaint(c, m) {
  if (painting.has(m.id)) return;
  painting.add(m.id);
  setTimeout(() => requestAnimationFrame(() => { painting.delete(m.id); paintNow(c, m); }), 40);
}

function paintNow(c, m) {
  if (state.conv !== c) return;
  const n = document.querySelector(`#messages .msg[data-id="${m.id}"]`);
  if (!n) return;
  const box = $('#messages');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  fillAsst(n, c, m);
  renderUsage();
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---------- 发送与流式接收 ----------

function fileBlock(f) {
  if (f.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.data } };
  if (f.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: f.name };
  return { type: 'text', text: `<file name="${f.name}">\n${f.text}\n</file>` };
}

function toApi(list) {
  return list.map(m => (m.role === 'user'
    ? { role: 'user', content: [...(m.files || []).map(fileBlock), ...(m.text ? [{ type: 'text', text: m.text }] : [])] }
    : { role: 'assistant', content: (m.blocks || []).filter(b => b?.type === 'text' && b.text.trim()).map(b => ({ type: 'text', text: b.text })) }))
    .filter(x => x.content.length);
}

async function persist(c) {
  if (c._deleted) return;
  const body = JSON.stringify(c, (k, v) => (k[0] === '_' ? undefined : v));
  try {
    const x = await api(`/api/conversations/${c.id}`, { method: 'PUT', text: body });
    c.updatedAt = x.updatedAt;
    if (c.source) c.localEdits = true;
    upsertMeta(x);
  } catch (e) {
    toast('保存失败：' + friendly(e), 4000);
  }
}

function upsertMeta(x) {
  state.list = [x, ...state.list.filter(y => y.id !== x.id)].sort((a, b) => b.updatedAt - a.updatedAt);
  renderList();
}

function send() {
  const c = state.conv;
  if (convLive(c)) return;
  const input = $('#input');
  const text = input.value.trim();
  const files = state.pending.slice();
  if (!text && !files.length) return;
  if (state.edit?.conv === c) c.messages.splice(state.edit.index);
  state.edit = null;
  $('#edit-bar').hidden = true;
  c.messages.push({ id: uid(), role: 'user', text, files, at: Date.now() });
  if (!c.titled && c.messages.length === 1) c.title = (text || files[0]?.name || '新对话').replace(/\s+/g, ' ').slice(0, 24);
  c.model = $('#model').value || c.model;
  input.value = '';
  state.pending = [];
  renderPending();
  autosize();
  state.cache.set(c.id, c);
  history.replaceState(null, '', `#${c.id}`);
  renderConv();
  persist(c);
  runAssistant(c);
}

async function runAssistant(c) {
  const s = state.settings;
  const payload = {
    model: c.model, messages: toApi(c.messages), system: s.systemPrompt,
    max_tokens: s.maxTokens, thinking: s.thinking, thinking_budget: s.thinkingBudget, effort: s.effort || '',
  };
  const m = { id: uid(), role: 'assistant', blocks: [], model: c.model, at: Date.now() };
  if (s.effort) m.effort = s.effort;
  c.messages.push(m);
  const ac = new AbortController();
  state.streams.set(m.id, { ac, conv: c });
  if (state.conv === c) {
    $('#messages').append(asstNode(c, m));
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
  updateComposer();
  renderList();
  try {
    const r = await api('/api/chat', { method: 'POST', body: payload, signal: ac.signal, raw: true });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error?.message || `HTTP ${r.status}`);
    }
    await readSSE(r.body, ev => onEvent(c, m, ev));
    if (!m._stopped) throw new Error('连接提前断开，回复可能不完整。');
  } catch (e) {
    if (ac.signal.aborted) m.stop = 'user_stop';
    else m.error = friendly(e);
  } finally {
    state.streams.delete(m.id);
    for (const b of m.blocks) if (b) b.done = true;
    paintNow(c, m);
    updateComposer();
    renderList();
    persist(c);
    if (!c.titled && !m.error && c.messages.length === 2) autoTitle(c);
  }
}

async function readSSE(stream, handle) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      handle(ev);
    }
  }
}

function onEvent(c, m, ev) {
  switch (ev.type) {
    case 'message_start':
      m.model = ev.message?.model || m.model;
      m.usage = { ...(ev.message?.usage || {}) };
      break;
    case 'content_block_start': {
      for (let i = 0; i < ev.index; i++) m.blocks[i] ||= { type: 'skip' };
      const cb = ev.content_block || {};
      m.blocks[ev.index] = cb.type === 'thinking' ? { type: 'thinking', text: cb.thinking || '' }
        : cb.type === 'text' ? { type: 'text', text: cb.text || '' } : { type: 'skip' };
      break;
    }
    case 'content_block_delta': {
      const b = m.blocks[ev.index];
      const d = ev.delta || {};
      if (!b) break;
      if (d.type === 'text_delta') b.text += d.text;
      else if (d.type === 'thinking_delta') b.text += d.thinking;
      else return;
      break;
    }
    case 'content_block_stop':
      if (m.blocks[ev.index]) m.blocks[ev.index].done = true;
      break;
    case 'message_delta':
      if (ev.delta?.stop_reason) m.stop = ev.delta.stop_reason;
      if (ev.usage) Object.assign((m.usage ||= {}), ev.usage);
      break;
    case 'message_stop':
      m._stopped = true;
      break;
    case 'error':
      throw new Error(ev.error?.message || '中转返回了错误');
    case 'effort_unsupported':
      m.effortDropped = true;
      delete m.effort;
      return;
    default:
      return;
  }
  schedulePaint(c, m);
}

function stop() {
  for (const s of state.streams.values()) if (s.conv === state.conv) s.ac.abort();
}

function regenerate(c) {
  if (convLive(c)) return;
  if (c.messages.at(-1)?.role === 'assistant') c.messages.pop();
  if (!c.messages.length) return;
  if (state.conv === c) renderConv();
  runAssistant(c);
}

async function autoTitle(c) {
  const [u, a] = c.messages;
  const reply = (a.blocks || []).filter(b => b?.type === 'text').map(b => b.text).join('').slice(0, 600);
  const text = `用户：${u.text || (u.files || []).map(f => f.name).join('、')}\n助手：${reply}`;
  try {
    const { title } = await api('/api/title', { method: 'POST', body: { text } });
    if (c.titled) return;
    c.title = title;
    c.titled = true;
    if (state.conv === c) setTitle(c);
    persist(c);
  } catch { /* 起标题失败就保留第一句话做标题 */ }
}

function startEdit(c, m) {
  if (convLive(c)) return toast('先停止当前回复再编辑');
  state.edit = { conv: c, index: c.messages.indexOf(m) };
  $('#input').value = m.text || '';
  state.pending = (m.files || []).slice();
  renderPending();
  $('#edit-bar').hidden = false;
  autosize();
  updateComposer();
  $('#input').focus();
}

function cancelEdit() {
  if (!state.edit) return;
  state.edit = null;
  $('#edit-bar').hidden = true;
  $('#input').value = '';
  state.pending = [];
  renderPending();
  autosize();
  updateComposer();
}

// ---------- 对话列表 ----------

function newConv() {
  const model = state.settings.defaultModel || state.config.defaultModel || state.favorites[0] || '';
  return { id: uid(), title: '新对话', model, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

function show(c) {
  if (state.edit && state.edit.conv !== c) cancelEdit();
  state.conv = c;
  history.replaceState(null, '', c.messages.length ? `#${c.id}` : location.pathname);
  setModelValue(c.model);
  renderConv();
  renderList();
  updateComposer();
  if (narrow()) collapse(true);
  $('#input').focus();
}

async function openConv(id) {
  let c = state.cache.get(id);
  if (!c) {
    try { c = await api(`/api/conversations/${id}`); } catch (e) { return toast('打不开这个对话：' + friendly(e), 4000); }
    state.cache.set(id, c);
  }
  show(c);
}

function startNew() {
  if (state.conv && !state.conv.messages.length) return $('#input').focus();
  show(newConv());
}

function groupOf(ts) {
  const today = new Date().setHours(0, 0, 0, 0);
  if (ts >= today) return '今天';
  if (ts >= today - 864e5) return '昨天';
  if (ts >= today - 6 * 864e5) return '最近 7 天';
  if (ts >= today - 29 * 864e5) return '最近 30 天';
  const d = new Date(ts);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

function renderList() {
  const box = $('#conv-list');
  box.textContent = '';
  const q = $('#search').value.trim().toLowerCase();
  const items = state.list.filter(x => !q || x.title.toLowerCase().includes(q));
  if (!items.length) return box.append(el('div', 'list-empty', q ? '没有匹配的对话' : '还没有对话'));
  const live = new Set([...state.streams.values()].map(s => s.conv.id));
  let last = '';
  for (const x of items) {
    const g = groupOf(x.updatedAt);
    if (g !== last) { box.append(el('div', 'group', g)); last = g; }
    const row = el('div', 'conv');
    row.classList.toggle('current', state.conv?.id === x.id);
    row.classList.toggle('live', live.has(x.id));
    const a = el('a', null, x.title);
    a.href = `#${x.id}`;
    a.title = x.source === 'claude-code' ? `${x.title}（从 Claude Code 导入）` : x.title;
    if (x.source === 'claude-code') a.prepend(el('span', 'badge', 'CC'));
    a.onclick = e => { e.preventDefault(); openConv(x.id); };
    const acts = el('div', 'acts');
    acts.append(iconBtn('edit', '重命名', () => rename(row, x)), iconBtn('trash', '删除', () => removeConv(x)));
    row.append(a, acts);
    box.append(row);
  }
}

function rename(row, x) {
  const inp = el('input');
  inp.value = x.title;
  inp.maxLength = 80;
  inp.setAttribute('aria-label', '对话标题');
  row.textContent = '';
  row.append(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async ok => {
    if (done) return;
    done = true;
    const t = inp.value.trim();
    if (ok && t && t !== x.title) {
      const c = state.cache.get(x.id) || await api(`/api/conversations/${x.id}`).catch(() => null);
      if (c) {
        c.title = t;
        c.titled = true;
        state.cache.set(c.id, c);
        if (state.conv === c) setTitle(c);
        await persist(c);
        return;
      }
    }
    renderList();
  };
  inp.onkeydown = e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}

async function removeConv(x) {
  if (!confirm(`删除"${x.title}"？删除后不能恢复。`)) return;
  const c = state.cache.get(x.id);
  if (c) c._deleted = true;
  for (const s of state.streams.values()) if (s.conv.id === x.id) s.ac.abort();
  try {
    await api(`/api/conversations/${x.id}`, { method: 'DELETE' });
  } catch (e) {
    if (c) c._deleted = false;
    return toast('删除失败：' + friendly(e), 4000);
  }
  state.cache.delete(x.id);
  state.list = state.list.filter(y => y.id !== x.id);
  if (state.conv?.id === x.id) show(newConv()); else renderList();
}

// ---------- 模型与设置 ----------

function fillModels() {
  const s = $('#model');
  s.textContent = '';
  const fav = el('optgroup');
  fav.label = '常用';
  state.favorites.forEach(id => fav.append(new Option(id, id)));
  s.append(fav);
  const rest = state.models.filter(id => !state.favorites.includes(id));
  if (rest.length) {
    const all = el('optgroup');
    all.label = '全部模型';
    rest.forEach(id => all.append(new Option(id, id)));
    s.append(all);
  }
  const d = $('#settings-form').elements.defaultModel;
  d.textContent = '';
  d.append(new Option(`跟随中转默认（${state.config.defaultModel || '未知'}）`, ''));
  state.models.forEach(id => d.append(new Option(id, id)));
}

function setModelValue(v) {
  const s = $('#model');
  if (v && ![...s.options].some(o => o.value === v)) s.append(new Option(v, v));
  if (v) s.value = v;
}

const mq = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const pref = state.settings.theme;
  const t = pref === 'light' || pref === 'dark' ? pref : mq.matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  $('#hl-light').disabled = t === 'dark';
  $('#hl-dark').disabled = t !== 'dark';
  lsSet('cd-theme', t);
}

async function saveSettings(patch) {
  // 先改本地状态，紧接着发出的消息就能用上新设置
  state.settings = { ...state.settings, ...patch };
  applyTheme();
  try {
    state.settings = await api('/api/settings', { method: 'PUT', body: state.settings });
  } catch (e) {
    toast('设置没保存上：' + friendly(e), 4000);
  }
  applyTheme();
  syncComposerSettings();
}

function syncComposerSettings() {
  $('#thinking').checked = Boolean(state.settings.thinking);
  $('#effort').value = state.settings.effort || '';
  $('#effort').closest('.effort-pick').classList.toggle('on', Boolean(state.settings.effort));
}

function openSettings() {
  const f = $('#settings-form').elements;
  const s = state.settings;
  f.systemPrompt.value = s.systemPrompt || '';
  f.defaultModel.value = s.defaultModel || '';
  f.theme.value = s.theme || 'system';
  f.maxTokens.value = s.maxTokens;
  f.thinkingBudget.value = s.thinkingBudget;
  f.autoImport.checked = s.autoImport !== false;
  showImportStatus();
  const info = $('#conn-info');
  info.textContent = '';
  info.append(
    el('div', null, `中转地址：${state.config.baseHost || '未知'}`),
    el('div', null, `API Key：${state.config.hasKey ? '已配置' : '未配置'}（Key 只在本地服务里使用，不会发给浏览器）`),
    el('div', null, '要改中转或 Key：编辑 ClaudeDesk 目录下的 config.json，或者 ~/.claude/settings.json 里的 env，保存即生效。'),
  );
  $('#settings').returnValue = '';
  $('#settings').showModal();
}

// ---------- 输入框与附件 ----------

const input = $('#input');

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.4)}px`;
}

function updateComposer() {
  const live = state.conv && convLive(state.conv);
  document.body.classList.toggle('streaming', Boolean(live));
  const btn = $('#btn-send');
  btn.disabled = !live && !input.value.trim() && !state.pending.length;
  btn.setAttribute('aria-label', live ? '停止生成' : '发送');
  btn.title = live ? '停止生成（Esc）' : '发送（Enter）';
}

function renderPending() {
  const box = $('#attachments');
  box.textContent = '';
  state.pending.forEach((f, i) => {
    const w = el('div', 'att');
    w.append(f.kind === 'image' ? fileImg(f) : fileChip(f));
    const x = el('button', 'x', '×');
    x.type = 'button';
    x.title = '移除';
    x.setAttribute('aria-label', `移除 ${f.name}`);
    x.onclick = () => { state.pending.splice(i, 1); renderPending(); updateComposer(); };
    w.append(x);
    box.append(w);
  });
}

const b64 = blob => new Promise((ok, bad) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1]);
  r.onerror = () => bad(new Error('读取失败'));
  r.readAsDataURL(blob);
});

// 长边超过 1568 像素或文件太大的图片先在本地缩小，省流量也省 token
async function readImage(f) {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error('图片读不出来'));
      i.src = url;
    });
    const scale = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && f.size <= 3.5 * (1 << 20)) return { kind: 'image', name: f.name, size: f.size, mediaType: f.type, data: await b64(f) };
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * scale);
    cv.height = Math.round(img.naturalHeight * scale);
    const ctx = cv.getContext('2d');
    let type = f.type === 'image/png' ? 'image/png' : 'image/jpeg';
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    let data = cv.toDataURL(type, 0.9).split(',')[1];
    if (data.length > 4.5 * (1 << 20)) {
      type = 'image/jpeg';
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      data = cv.toDataURL(type, 0.85).split(',')[1];
    }
    return { kind: 'image', name: f.name, size: Math.round(data.length * 0.75), mediaType: type, data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|cfg|conf|log|py|ipynb|js|mjs|cjs|ts|tsx|jsx|vue|svelte|html?|css|scss|less|java|kt|go|rs|c|h|cc|cpp|hpp|cs|rb|php|swift|m|sh|bash|ps1|bat|cmd|sql|r|lua|dart|scala|gradle|env|srt|vtt)$/i;

async function addFiles(list) {
  for (const f of list) {
    try {
      if (/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) {
        state.pending.push(await readImage(f));
      } else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        if (f.size > 30 * (1 << 20)) throw new Error('PDF 超过 30 MB');
        state.pending.push({ kind: 'pdf', name: f.name, size: f.size, mediaType: 'application/pdf', data: await b64(f) });
      } else if (f.type.startsWith('text/') || f.type === 'application/json' || TEXT_EXT.test(f.name)) {
        if (f.size > 2 * (1 << 20)) throw new Error('文本文件超过 2 MB');
        const text = await f.text();
        if (text.includes('\u0000')) throw new Error('看起来不是文本文件');
        state.pending.push({ kind: 'text', name: f.name, size: f.size, text });
      } else {
        throw new Error('暂不支持这种文件，可以添加图片、PDF 和文本或代码文件');
      }
    } catch (e) {
      toast(`${f.name}：${e.message}`, 4000);
    }
  }
  renderPending();
  updateComposer();
  input.focus();
}

// ---------- 侧栏、连接状态 ----------

const narrow = () => matchMedia('(max-width: 760px)').matches;

function collapse(v) {
  document.body.classList.toggle('collapsed', v);
  $('#scrim').hidden = v || !narrow();
  if (!narrow()) lsSet('cd-collapsed', v ? '1' : '');
}

function setConn(ok) {
  $('#conn').className = `conn ${ok ? 'ok' : 'bad'}`;
  $('#conn-text').textContent = ok ? `已连接 ${state.config.baseHost || ''}` : '本地服务已断开，请重新打开';
}

let importVersion = null;
let fastPoll = null;

async function ping() {
  try {
    const r = await api('/api/ping', { method: 'POST', body: { id: CLIENT_ID } });
    setConn(true);
    if (importVersion !== null && r.importVersion !== importVersion) await refreshList();
    importVersion = r.importVersion;
    // 导入还在跑就勤快点问，跑完马上刷新列表
    clearTimeout(fastPoll);
    if (r.importing) fastPoll = setTimeout(ping, 1500);
  } catch {
    setConn(false);
  }
}

// 后台导入更新了对话：刷新列表，丢掉过期的缓存（正在看或正在生成的不动）
async function refreshList() {
  try {
    const list = await api('/api/conversations');
    const fresh = new Map(list.map(x => [x.id, x.updatedAt]));
    for (const [id, c] of state.cache) {
      if (c === state.conv || convLive(c)) continue;
      if (fresh.get(id) !== c.updatedAt) state.cache.delete(id);
    }
    state.list = list;
    renderList();
  } catch { /* 下次心跳再试 */ }
}

function importSummary(s) {
  const last = s.last;
  if (s.running) return '正在导入…';
  if (!last) return '还没导入过。';
  const t = new Date(last.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const n = state.list.filter(x => x.source === 'claude-code').length;
  const parts = [`共 ${n} 个 Claude Code 会话`, `上次检查 ${t}`];
  if (last.added || last.updated) parts.push(`新增 ${last.added}，更新 ${last.updated}`);
  if (last.kept) parts.push(`${last.kept} 个在这里改过，未覆盖`);
  if (last.errors?.length) parts.push(`出错 ${last.errors.length} 个：${last.errors[0]}`);
  return parts.join(' · ');
}

async function showImportStatus() {
  try { $('#import-status').textContent = importSummary(await api('/api/import')); } catch (e) { $('#import-status').textContent = friendly(e); }
}

async function importNow(btn) {
  btn.disabled = true;
  $('#import-status').textContent = '正在导入…';
  try {
    const s = await api('/api/import', { method: 'POST', body: { force: true } });
    await refreshList();
    importVersion = s.version;
    $('#import-status').textContent = importSummary(s);
  } catch (e) {
    $('#import-status').textContent = '导入失败：' + friendly(e);
  }
  btn.disabled = false;
}

function greet() {
  const h = new Date().getHours();
  $('#greeting').textContent = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  $('#welcome-sub').textContent = '今天想聊点什么？';
}

// ---------- 事件绑定 ----------

$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  if (convLive(state.conv)) stop(); else send();
});
input.addEventListener('input', () => { autosize(); updateComposer(); });
input.addEventListener('keydown', e => {
  // 输入法候选状态下的 Enter 不发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    if (!convLive(state.conv)) send();
  }
});
input.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length && !e.clipboardData.getData('text/plain')) {
    e.preventDefault();
    addFiles(files);
  }
});
$('#btn-attach').onclick = () => $('#file').click();
$('#file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#edit-cancel').onclick = cancelEdit;
$('#thinking').onchange = e => saveSettings({ thinking: e.target.checked });
$('#effort').onchange = e => saveSettings({ effort: e.target.value });
$('#usage').onclick = () => ($('#usage-pop').hidden ? openUsage() : closeUsage());
document.addEventListener('click', e => { if (!e.target.closest('.usage-wrap')) closeUsage(); });
$('#model').onchange = e => {
  const c = state.conv;
  c.model = e.target.value;
  renderUsage();
  if (c.messages.length && !convLive(c)) persist(c);
};
$('#btn-new').onclick = startNew;
$('#btn-settings').onclick = openSettings;
$('#btn-collapse').onclick = () => collapse(true);
$('#btn-expand').onclick = () => collapse(false);
$('#scrim').onclick = () => collapse(true);
$('#search').addEventListener('input', renderList);
$('#messages').addEventListener('click', e => {
  const b = e.target.closest('.copy-code');
  if (b) copyText(b.closest('.code').querySelector('code').textContent, b);
});
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const f = $('#settings-form').elements;
  saveSettings({
    systemPrompt: f.systemPrompt.value, defaultModel: f.defaultModel.value, theme: f.theme.value,
    maxTokens: Number(f.maxTokens.value), thinkingBudget: Number(f.thinkingBudget.value),
    autoImport: f.autoImport.checked,
  });
});
$('#btn-import').onclick = e => importNow(e.currentTarget);
mq.addEventListener('change', applyTheme);
matchMedia('(max-width: 760px)').addEventListener('change', e => collapse(e.matches || lsGet('cd-collapsed') === '1'));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#usage-pop').hidden) { closeUsage(); $('#usage').focus(); return; }
  if (e.key === 'Escape' && state.conv && convLive(state.conv) && !$('#settings').open) stop();
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); startNew(); }
});

let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('#drop').hidden = false; } });
addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

addEventListener('pagehide', () => {
  navigator.sendBeacon('/api/bye', new Blob([JSON.stringify({ id: CLIENT_ID })], { type: 'application/json' }));
});
setInterval(ping, 20000);

// ---------- 启动 ----------

(async function init() {
  const t = lsGet('cd-theme');
  if (t) document.documentElement.dataset.theme = t;
  collapse(narrow() || lsGet('cd-collapsed') === '1');
  greet();
  try {
    const [settings, config, models, list] = await Promise.all([
      api('/api/settings'), api('/api/config'), api('/api/models'), api('/api/conversations'),
    ]);
    Object.assign(state, { settings, config, models: models.models, favorites: models.favorites, list });
    if (models.error) toast('模型列表获取失败，先用默认模型。' + models.error, 5000);
    setConn(true);
  } catch (e) {
    setConn(false);
    toast('连不上本地服务：' + friendly(e), 6000);
  }
  applyTheme();
  fillModels();
  syncComposerSettings();
  const id = location.hash.slice(1);
  if (id && state.list.some(x => x.id === id)) await openConv(id); else show(newConv());
  ping();
})();

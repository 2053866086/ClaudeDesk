/*
 * 导入 Claude Code 的会话记录（~/.claude/projects/<项目>/<会话ID>.jsonl）
 *
 * 每个会话变成一个 ClaudeDesk 对话，ID 为 cc-<会话ID>。
 * 只保留人能看懂的部分：用户消息、助手正文、思考过程，以及截断后的工具调用。
 * 系统提醒、任务通知、斜杠命令输出这些不保留。
 * 源文件有变化就重新导入；在 ClaudeDesk 里继续聊过或改过名的对话不再覆盖；删掉的不会再导回来。
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const MAX_TOOL_IN = 600;
const MAX_TOOL_OUT = 1500;
const MAX_THINK = 4000;
const RECENT_MS = 4000;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…（还有 ${(s.length - n).toLocaleString()} 字省略）` : s);

// 会话里可能读过配置文件，常见格式的密钥先打码再存
const SECRET_RE = /\b(sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g;
const redact = s => String(s ?? '').replace(SECRET_RE, m => `${m.slice(0, 6)}…[已隐藏]`);

const NOISE_START = /^\s*<(task-notification|local-command-caveat|local-command-stdout|command-message)>/;
const SKILL_START = /^Base directory for this skill:/;

function cleanUserText(raw) {
  let s = String(raw || '');
  if (NOISE_START.test(s) || SKILL_START.test(s)) return '';
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
  // 斜杠命令只留命令本身，比如 /model opus
  const cmd = s.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    s = `${cmd[1].trim()} ${args.trim()}`.trim();
  }
  s = s.replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_, c) => `! ${c.trim()}`)
    .replace(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/g, (_, c) => (c.trim() ? `\n${clip(c.trim(), 800)}` : ''))
    .replace(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/g, (_, c) => (c.trim() ? `\n${clip(c.trim(), 800)}` : ''))
    .replace(/^\[Request interrupted by user[^\]]*\]$/m, '');
  return redact(s.trim());
}

function toolDesc(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const v = i.description || i.command || i.file_path || i.notebook_path || i.url || i.query || i.pattern || i.prompt || i.skill
    || Object.values(i).find(x => typeof x === 'string') || '';
  const extra = (name === 'Grep' || name === 'Glob') && i.path ? `  ${i.path}` : '';
  return redact(String(v).replace(/\s+/g, ' ').trim().slice(0, 120) + extra);
}

// 工具参数按"键: 值"逐行显示，字符串不转义，比 JSON 好读
function formatInput(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === 'string') return input[keys[0]];
  return keys.map(k => `${k}: ${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`).join('\n');
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map(b => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[图片]' : '')).filter(Boolean).join('\n');
}

async function convert(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const messages = [];
  const tools = new Map();
  let asst = null;
  const titles = new Map();
  let model = '';
  let cwd = '';
  let first = 0;
  let last = 0;
  let n = 0;
  const stamp = t => {
    const ms = Date.parse(t);
    if (ms) { first ||= ms; last = Math.max(last, ms); }
    return ms || last || Date.now();
  };
  const pushUser = (text, at) => {
    if (!text) return;
    messages.push({ id: `u${++n}`, role: 'user', text, files: [], at });
    asst = null;
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }   // 正在写入的最后一行可能不完整
    // Claude Code 会反复写入标题，中途可能换过，取出现次数最多的那个
    if (d.type === 'ai-title' && d.aiTitle) { titles.set(d.aiTitle, (titles.get(d.aiTitle) || 0) + 1); continue; }
    if (d.type === 'summary' && d.summary) { titles.set(d.summary, (titles.get(d.summary) || 0) + 1); continue; }
    if (d.isSidechain) continue;
    if (!cwd && d.cwd) cwd = d.cwd;

    if (d.type === 'attachment') {
      const a = d.attachment || {};
      if (a.type === 'queued_command' && typeof a.prompt === 'string' && (!a.commandMode || a.commandMode === 'prompt')) {
        pushUser(cleanUserText(a.prompt), stamp(d.timestamp));
      }
      continue;
    }

    if (d.type === 'user') {
      if (d.isMeta) continue;
      const at = stamp(d.timestamp);
      const c = d.message?.content;
      if (typeof c === 'string') { pushUser(cleanUserText(c), at); continue; }
      if (!Array.isArray(c)) continue;
      const texts = [];
      for (const b of c) {
        if (b?.type === 'tool_result') {
          const t = tools.get(b.tool_use_id);
          if (t) { t.result = clip(redact(resultText(b.content)).trim(), MAX_TOOL_OUT); t.error = Boolean(b.is_error); }
        } else if (b?.type === 'text') {
          texts.push(b.text);
        } else if (b?.type === 'image') {
          texts.push('[图片]');
        }
      }
      if (texts.length) pushUser(cleanUserText(texts.join('\n')), at);
      continue;
    }

    if (d.type === 'assistant') {
      if (d.isApiErrorMessage) continue;
      const msg = d.message || {};
      if (msg.model === '<synthetic>') continue;
      const at = stamp(d.timestamp);
      if (msg.model) model = msg.model;
      if (!asst) {
        asst = { id: `a${++n}`, role: 'assistant', blocks: [], model: msg.model || model, at };
        messages.push(asst);
      }
      // 同一次 API 调用会拆成多行、每行带同样的 usage，按 message.id 去重后再累加
      if (msg.usage) {
        (asst._calls ||= new Map()).set(msg.id || `l${n}`, msg.usage);
        asst.usage = msg.usage;
      }
      if (d.effort) asst.effort = d.effort;
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type === 'text' && b.text?.trim()) {
          asst.blocks.push({ type: 'text', text: redact(b.text) });
        } else if (b?.type === 'thinking' && b.thinking?.trim()) {
          asst.blocks.push({ type: 'thinking', text: clip(redact(b.thinking), MAX_THINK) });
        } else if (b?.type === 'tool_use') {
          const t = { type: 'tool', name: String(b.name || 'tool'), desc: toolDesc(b.name, b.input), input: clip(redact(formatInput(b.input)), MAX_TOOL_IN), result: '', error: false };
          tools.set(b.id, t);
          asst.blocks.push(t);
        }
      }
    }
  }

  for (const m of messages) {
    if (!m._calls) continue;
    const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: m._calls.size };
    for (const u of m._calls.values()) {
      t.input += u.input_tokens || 0;
      t.cacheRead += u.cache_read_input_tokens || 0;
      t.cacheWrite += u.cache_creation_input_tokens || 0;
      t.output += u.output_tokens || 0;
    }
    m.usageTotal = t;
    delete m._calls;
  }
  const kept = messages.filter(m => m.role === 'user' || m.blocks.length);
  if (!kept.some(m => m.role === 'user')) return null;
  let title = '';
  let best = 0;
  for (const [t, c] of titles) if (c >= best) { title = t; best = c; }
  // 没有标题时用第一句正常的话，跳过 /model、! 命令这类
  const firstUser = (kept.find(m => m.role === 'user' && !/^[/!]/.test(m.text)) || kept.find(m => m.role === 'user')).text;
  return {
    title: (title || firstUser.replace(/\s+/g, ' ').slice(0, 30) || 'Claude Code 会话').slice(0, 80),
    titled: Boolean(title),
    // 回复里的模型名是中转改写过的（如 claude-opus-5.5），拿来发请求会报错，所以对话本身不指定模型、用默认的
    model: '',
    createdAt: first || Date.now(),
    updatedAt: last || first || Date.now(),
    cwd,
    messages: kept,
  };
}

/*
 * ctx: { projectsDir, convDir, stateFile, ID_RE, withLock, writeAtomic, meta, metaOf }
 * 返回 { scanned, added, updated, skipped, errors }
 */
function createImporter(ctx) {
  let running = null;
  const status = { version: 0, running: false, last: null };

  const readState = () => {
    try { return JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8')); } catch { return { files: {}, deleted: [] }; }
  };
  const writeState = s => ctx.writeAtomic(ctx.stateFile, JSON.stringify(s, null, 1));

  async function saveOne(id, conv, sessionId, project) {
    return ctx.withLock(id, async () => {
      const p = path.join(ctx.convDir, `${id}.json`);
      let old = null;
      try { old = JSON.parse(await fsp.readFile(p, 'utf8')); } catch { /* 第一次导入 */ }
      if (old?.localEdits) return 'kept';
      const c = {
        id, ...conv,
        source: { type: 'claude-code', sessionId, project, cwd: conv.cwd, file: `${project}/${sessionId}.jsonl` },
      };
      delete c.cwd;
      if (old && old.title !== old.source?.importedTitle) { c.title = old.title; c.titled = true; }
      c.source.importedTitle = c.title;
      await ctx.writeAtomic(p, JSON.stringify(c));
      ctx.meta.set(id, ctx.metaOf(c));
      return old ? 'updated' : 'added';
    });
  }

  async function run(force = false, restore = false) {
    const st = readState();
    // restore：把删掉的会话重新导回来
    if (restore) {
      for (const id of st.deleted || []) for (const k of Object.keys(st.files)) if (k.endsWith(`/${id.slice(3)}.jsonl`)) delete st.files[k];
      st.deleted = [];
    }
    const deleted = new Set(st.deleted || []);
    const r = { scanned: 0, added: 0, updated: 0, skipped: 0, kept: 0, errors: [] };
    let dirs = [];
    try { dirs = await fsp.readdir(ctx.projectsDir, { withFileTypes: true }); } catch (e) { r.errors.push(`读不到 ${ctx.projectsDir}：${e.code || e.message}`); }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const pdir = path.join(ctx.projectsDir, dir.name);
      let files = [];
      try { files = await fsp.readdir(pdir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const sessionId = f.slice(0, -6);
        const id = `cc-${sessionId}`;
        if (!ctx.ID_RE.test(id) || deleted.has(id)) continue;
        r.scanned++;
        const full = path.join(pdir, f);
        try {
          const s = await fsp.stat(full);
          const key = `${dir.name}/${f}`;
          const seen = st.files[key];
          if (!force && seen && seen.mtime === s.mtimeMs && seen.size === s.size) { r.skipped++; continue; }
          if (Date.now() - s.mtimeMs < RECENT_MS && seen) { r.skipped++; continue; }   // 正在写入，下一轮再导
          const conv = await convert(full);
          st.files[key] = { mtime: s.mtimeMs, size: s.size };
          if (!conv) { r.skipped++; continue; }
          r[await saveOne(id, conv, sessionId, dir.name)]++;
        } catch (e) {
          r.errors.push(`${f}：${e.message}`);
        }
        await new Promise(ok => setImmediate(ok));
      }
    }
    await writeState(st);
    if (r.added || r.updated) status.version++;
    status.last = { at: Date.now(), ...r };
    return r;
  }

  return {
    status,
    run(force, restore) {
      if (running) return running;
      status.running = true;
      running = run(force, restore).finally(() => { running = null; status.running = false; });
      return running;
    },
    forget(id) {
      if (!id.startsWith('cc-')) return;
      const st = readState();
      st.deleted = [...new Set([...(st.deleted || []), id])];
      return writeState(st);
    },
  };
}

module.exports = { createImporter, convert };

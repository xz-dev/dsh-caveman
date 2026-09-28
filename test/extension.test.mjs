import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  apply,
  Config,
  filterSkillBodyForMode,
  getPonytailInstructions,
  ponytailSkillPaths,
  wrapShellForRtk,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
  const listeners = new Map();
  const commands = new Map();
  const sections = [];
  const statusWrites = [];
  const toasts = [];
  const services = new Map();
  const logs = { warn: [], info: [] };

  if (overrides.tuiStatus !== null) {
    services.set('tuiStatus', {
      set: (key, text) => statusWrites.push({ key, text }),
    });
  }
  if (overrides.tuiToast !== null) {
    services.set('tuiToast', {
      show: (text, options) => { toasts.push({ text, options }); return true; },
    });
  }
  for (const [k, v] of Object.entries(overrides.services || {})) services.set(k, v);

  const ctx = {
    logger: () => ({
      warn: (...a) => logs.warn.push(a.join(' ')),
      info: (...a) => logs.info.push(a.join(' ')),
    }),
    get: (name) => services.get(name),
    on: (event, fn) => { listeners.set(event, fn); return () => {}; },
    commands: {
      register: (def) => { commands.set(def.name, def); return () => {}; },
    },
    systemPrompt: {
      section: (s) => { sections.push(s); return () => {}; },
    },
  };

  apply(ctx, overrides.config || Config.parse?.({}) || {
    ponytailDefaultMode: 'full', ponytailHideStatus: false, ponytailQuietStartup: false,
    cavemanDefaultLevel: 'full', cavemanShowStatus: true, rtkEnabled: true,
  });
  return { ctx, listeners, commands, sections, statusWrites, toasts, logs, services };
}

function makeSession(entries = []) {
  const appended = [];
  return {
    appended,
    snapshotEvents: () => entries,
    append: (type, data) => { appended.push({ type, data }); entries.push({ type, data }); },
  };
}

function makeAgent(session) {
  const cancelled = [];
  const followups = [];
  return {
    session,
    cancelled,
    followups,
    cancel: (cause, options) => cancelled.push({ cause, options }),
    followup: (msg) => followups.push(msg),
  };
}

function makeInvocation(agent, rawInput = '') {
  return { agent, rawInput, signal: new AbortController().signal, attachments: [], commandId: 't' };
}

function withTempConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caveman-test-'));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  return Promise.resolve().then(fn).finally(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });
}

function sectionText(h, name) {
  const s = h.sections.find((x) => x.name === name);
  return s ? s.text({}) : undefined;
}

// ---------------------------------------------------------------------------
// Caveman
// ---------------------------------------------------------------------------

test('registers all commands', () => {
  const { commands } = makeCtx();
  assert.deepEqual([...commands.keys()].sort(), [
    'abort', 'caveman', 'ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review',
  ]);
});

test('/caveman toggles and injects prompt on agent/created', () => withTempConfig(() => {
  const h = makeCtx();
  const session = makeSession();
  const agent = makeAgent(session);
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  // default level full → caveman section active
  assert.match(sectionText(h, 'dsh-caveman:caveman'), /CAVEMAN MODE/);
  assert.match(sectionText(h, 'dsh-caveman:ponytail'), /PONYTAIL MODE ACTIVE/);
  // command to off
  const res = h.commands.get('caveman').handler(makeInvocation(agent, 'off'));
  assert.equal(res.kind, 'success');
  assert.equal(sectionText(h, 'dsh-caveman:caveman'), '');
  // toggle back with no arg
  h.commands.get('caveman').handler(makeInvocation(agent, ''));
  assert.match(sectionText(h, 'dsh-caveman:caveman'), /CAVEMAN MODE/);
}));

test('/caveman levels set intensity; unknown arg errors', () => withTempConfig(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  h.commands.get('caveman').handler(makeInvocation(agent, 'ultra'));
  assert.match(sectionText(h, 'dsh-caveman:caveman'), /Abbreviate.*DB\/auth/);
  h.commands.get('caveman').handler(makeInvocation(agent, 'wenyan'));
  assert.match(sectionText(h, 'dsh-caveman:caveman'), /文言|classical|文言文/i);
  h.commands.get('caveman').handler(makeInvocation(agent, 'micro'));
  assert.match(sectionText(h, 'dsh-caveman:caveman'), /Token efficiency/);
  const bad = h.commands.get('caveman').handler(makeInvocation(agent, 'bogus'));
  assert.equal(bad.kind, 'error');
}));

test('/caveman stop/quit aliases disable; config returns text', () => withTempConfig(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  for (const a of ['stop', 'quit', 'off']) {
    h.commands.get('caveman').handler(makeInvocation(agent, a));
    assert.equal(sectionText(h, 'dsh-caveman:caveman'), '');
    h.commands.get('caveman').handler(makeInvocation(agent, 'full'));
  }
  const cfg = h.commands.get('caveman').handler(makeInvocation(agent, 'config'));
  assert.equal(cfg.kind, 'success');
  assert.match(cfg.text, /Caveman config/);
}));

test('caveman level restores from session events on resume', () => withTempConfig(() => {
  const h = makeCtx();
  const session = makeSession([{ type: 'dsh-caveman/caveman-level', data: { level: 'ultra' } }]);
  h.listeners.get('agent/created')({ agent: makeAgent(session), source: 'resume' });
  assert.match(sectionText(h, 'dsh-caveman:caveman'), /Abbreviate/);
}));

test('caveman status writes fire frames and stop when off', () => withTempConfig(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  const writes = h.statusWrites.filter((w) => w.key === 'caveman');
  assert.ok(writes.length >= 1);
  assert.match(writes.at(-1).text, /caveman level: FULL/);
  h.commands.get('caveman').handler(makeInvocation(agent, 'off'));
  assert.equal(h.statusWrites.filter((w) => w.key === 'caveman').at(-1).text, undefined);
}));

// ---------------------------------------------------------------------------
// Ponytail
// ---------------------------------------------------------------------------

test('/ponytail sets mode and injects instructions', () => withTempConfig(() => {
  const h = makeCtx();
  const session = makeSession();
  const agent = makeAgent(session);
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  h.commands.get('ponytail').handler(makeInvocation(agent, 'ultra'));
  const text = sectionText(h, 'dsh-caveman:ponytail');
  assert.match(text, /PONYTAIL MODE ACTIVE — level: ultra/);
  assert.ok(session.appended.some((e) => e.type === 'dsh-caveman/ponytail-mode' && e.data.mode === 'ultra'));
}));

test('ponytail session restore and off', () => withTempConfig(() => {
  const h = makeCtx();
  const session = makeSession([{ type: 'dsh-caveman/ponytail-mode', data: { mode: 'lite' } }]);
  const agent = makeAgent(session);
  h.listeners.get('agent/created')({ agent, source: 'resume' });
  assert.match(sectionText(h, 'dsh-caveman:ponytail'), /level: lite/);
  h.commands.get('ponytail').handler(makeInvocation(agent, 'off'));
  assert.equal(sectionText(h, 'dsh-caveman:ponytail'), '');
}));

test('ponytail status command reports modes; default writes config file', () => withTempConfig(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  const st = h.commands.get('ponytail').handler(makeInvocation(agent, 'status'));
  assert.match(st.text, /current full/);
  const d = h.commands.get('ponytail').handler(makeInvocation(agent, 'default ultra'));
  assert.equal(d.kind, 'success');
  const cfg = JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME, 'ponytail', 'config.json'), 'utf8'));
  assert.equal(cfg.defaultMode, 'ultra');
}));

test('tui/input decision consumes whole-message deactivation', () => withTempConfig(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  const tuiInput = h.listeners.get('tui/input');
  // non-command text: no opinion
  assert.equal(tuiInput({ text: 'add a normal mode toggle', delivery: 'followup' }), undefined);
  // whole-message deactivation: mode off + line consumed
  const d = tuiInput({ text: 'stop ponytail', delivery: 'followup' });
  assert.deepEqual(d, { handled: true, notice: 'Ponytail mode set to off.' });
  assert.equal(sectionText(h, 'dsh-caveman:ponytail'), '');
}));

test('inbox fallback still deactivates when decision layer absent', () => withTempConfig(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  h.listeners.get('agent/inbox/inserted')({ agent, message: { content: [{ type: 'text', text: 'normal mode.' }] } });
  assert.equal(sectionText(h, 'dsh-caveman:ponytail'), '');
}));

test('skill alias commands queue followup messages', () => withTempConfig(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  for (const cmd of ['ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help']) {
    h.commands.get(cmd).handler(makeInvocation(agent, ''));
  }
  assert.deepEqual(
    agent.followups.map((m) => m.content[0].text),
    ['/skill:ponytail-review', '/skill:ponytail-audit', '/skill:ponytail-debt', '/skill:ponytail-gain', '/skill:ponytail-help'],
  );
}));

test('ponytail status bar renders mode dot on/off', () => withTempConfig(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.listeners.get('agent/created')({ agent, source: 'startup' });
  h.listeners.get('agent/status')({ agent, status: 'running' });
  const writes = h.statusWrites.filter((w) => w.key === 'ponytail');
  assert.ok(writes.some((w) => /●.*FULL/.test(w.text)));
  h.listeners.get('agent/status')({ agent, status: 'idle' });
  assert.ok(h.statusWrites.filter((w) => w.key === 'ponytail').some((w) => /○.*FULL/.test(w.text)));
}));

test('ponytail hideStatus suppresses indicator', () => withTempConfig(() => {
  process.env.PONYTAIL_HIDE_STATUS = '1';
  try {
    const h = makeCtx();
    const agent = makeAgent(makeSession());
    h.listeners.get('agent/created')({ agent, source: 'startup' });
    assert.equal(h.statusWrites.filter((w) => w.key === 'ponytail').length, 0);
  } finally { delete process.env.PONYTAIL_HIDE_STATUS; }
}));

test('quiet startup suppresses loaded toast', () => withTempConfig(() => {
  process.env.PONYTAIL_QUIET_STARTUP = '1';
  try {
    const h = makeCtx();
    h.listeners.get('agent/created')({ agent: makeAgent(makeSession()), source: 'startup' });
    assert.equal(h.toasts.filter((t) => /Ponytail loaded/.test(t.text)).length, 0);
  } finally { delete process.env.PONYTAIL_QUIET_STARTUP; }
}));

// ---------------------------------------------------------------------------
// filterSkillBodyForMode / getPonytailInstructions
// ---------------------------------------------------------------------------

const SKILL = `---
name: ponytail
---
# Header
| **full** | full row |
| **ultra** | ultra row |
| Rule stays |
- lite: "lite example"
- full: "full example"
- ultra: "ultra example"
- NotAMode: "kept"
Normal bullet stays.
`;

test('filterSkillBodyForMode keeps only matching mode rows/examples', () => {
  const out = filterSkillBodyForMode(SKILL, 'ultra');
  assert.match(out, /ultra row/);
  assert.match(out, /ultra example/);
  assert.doesNotMatch(out, /full row/);
  assert.doesNotMatch(out, /lite example/);
  assert.match(out, /NotAMode: "kept"/);
  assert.match(out, /Normal bullet stays/);
});

test('ponytail skill is looked up in $DSH_HOME/skills then ~/.agents/skills', () => {
  const paths = ponytailSkillPaths({ DSH_HOME: '/d', DSH_AGENTS_HOME: '/a' });
  assert.deepEqual(paths, ['/d/skills/ponytail/SKILL.md', '/a/skills/ponytail/SKILL.md']);
});

test('getPonytailInstructions falls back when skill missing', () => {
  // HOME may not have the skill in test env; fallback must still include level.
  const out = getPonytailInstructions('ultra');
  assert.match(out, /PONYTAIL MODE ACTIVE — level: ultra/);
});

// ---------------------------------------------------------------------------
// /abort
// ---------------------------------------------------------------------------

test('/abort cancels the invocation agent', () => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  const res = h.commands.get('abort').handler(makeInvocation(agent));
  assert.equal(res.kind, 'success');
  assert.deepEqual(agent.cancelled, [{ cause: { kind: 'user' }, options: undefined }]);
});

// ---------------------------------------------------------------------------
// rtk shell wrapper
// ---------------------------------------------------------------------------

test('wrapShellForRtk rewrites spec.command via rtk', async () => {
  const calls = [];
  const shell = { execute: async (spec) => { calls.push(spec.command); return 'ok'; } };
  const ctx = { get: () => undefined, logger: () => ({ warn() {} }) };
  wrapShellForRtk(ctx, shell, async (cmd) => (cmd === 'npm test' ? 'rtk npm test' : null));
  await shell.execute({ command: 'npm test', argv: ['bash', '-c', 'npm test'] });
  await shell.execute({ command: 'ls', argv: ['bash', '-c', 'ls'] });
  await shell.execute({ command: 'rtk x', argv: ['bash', '-c', 'rtk x'] });
  assert.deepEqual(calls, ['rtk npm test', 'ls', 'rtk x']);
});

test('wrapShellForRtk respects RTK_DISABLED and pass-through', async () => {
  const calls = [];
  const shell = { execute: async (spec) => { calls.push(spec.command); return 'ok'; } };
  wrapShellForRtk({}, shell, async () => 'rewritten');
  process.env.RTK_DISABLED = '1';
  try { await shell.execute({ command: 'git status' }); } finally { delete process.env.RTK_DISABLED; }
  await shell.execute({ command: '' });
  assert.deepEqual(calls, ['git status', '']);
});

test('rtk wrapper never throws (fail-open)', async () => {
  const calls = [];
  const shell = { execute: async (spec) => { calls.push(spec.command); return 'ok'; } };
  wrapShellForRtk({}, shell, async () => { throw new Error('boom'); });
  await shell.execute({ command: 'git status' });
  assert.deepEqual(calls, ['git status']);
});

// dsh-caveman — DSH port of pi-caveman, ponytail, pi-abort-command, and rtk.ts.
// One cordis plugin; four feature groups, each faithful to its Pi source.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
// The '@deepseek-ai/' prefixes are literal — pnpm install of this package into
// a profile resolves them against the profile's hoisted node_modules (the same
// mechanism third-party dsh plugins like @syncended/dsh-retry rely on).
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-caveman';
// `shell` + `subprocess` are optional peers: cordis 4 array-inject has no
// optional-entry form (an object entry becomes the literal key
// "[object Object]" and the fiber pends forever), so the rtk wiring mounts in
// a `ctx.inject([...])` sub-fiber below — dormant until both services exist.
export const inject = [
  'systemPrompt',
  'commands',
  'agents',
];

// ---------------------------------------------------------------------------
// Config (schemastery z; surfaced by dsh-settings into the TUI /settings screen)
// ---------------------------------------------------------------------------

const CAVEMAN_LEVELS = ['off', 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan', 'wenyan-ultra', 'micro'];
const PONYTAIL_MODES = ['off', 'lite', 'full', 'ultra'];

export const Config = z.object({
  // Ponytail knobs (ponytail-config.js analogues; env vars still win).
  ponytailDefaultMode: z.union(PONYTAIL_MODES.map((m) => z.const(m))).default('full'),
  ponytailHideStatus: z.boolean().default(false),
  ponytailQuietStartup: z.boolean().default(false),
  // Caveman knobs.
  cavemanDefaultLevel: z.union(CAVEMAN_LEVELS.map((m) => z.const(m))).default('full'),
  cavemanShowStatus: z.boolean().default(true),
  // rtk rewrite.
  rtkEnabled: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Persisted ponytail defaults: ~/.config/ponytail/config.json (ponytail's own
// XDG file, shared with other ponytail hosts) is consulted first; the DSH
// patch row config is the fallback. Caveman reads only the plugin config.
// ---------------------------------------------------------------------------

function envTruthy(value) {
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

function readJsonSafe(path) {
  try {
    const raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function xdgConfigHome() {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.platform === 'win32') {
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  }
  return join(homedir(), '.config');
}

// ponytail's persisted config (ponytail-config.js).
function ponytailFileConfig() {
  return readJsonSafe(join(xdgConfigHome(), 'ponytail', 'config.json'));
}

function ponytailDefaultMode(config) {
  const env = envTruthy(process.env.PONYTAIL_DEFAULT_MODE) ? process.env.PONYTAIL_DEFAULT_MODE.trim().toLowerCase() : undefined;
  if (env && PONYTAIL_MODES.includes(env)) return env;
  const file = ponytailFileConfig();
  if (typeof file.defaultMode === 'string' && PONYTAIL_MODES.includes(file.defaultMode.trim().toLowerCase())) {
    return file.defaultMode.trim().toLowerCase();
  }
  return config.ponytailDefaultMode;
}

function ponytailHideStatus(config) {
  const env = envTruthy(process.env.PONYTAIL_HIDE_STATUS);
  if (env !== undefined) return env;
  const file = ponytailFileConfig();
  if (file.hideStatus === true) return true;
  return config.ponytailHideStatus;
}

function ponytailQuietStartup(config) {
  const env = envTruthy(process.env.PONYTAIL_QUIET_STARTUP);
  if (env !== undefined) return env;
  const file = ponytailFileConfig();
  if (file.quietStartup === true) return true;
  return config.ponytailQuietStartup;
}

function writePonytailDefaultMode(mode) {
  // Mirrors writeDefaultMode in ponytail-config.js: only runtime levels persist.
  if (!PONYTAIL_MODES.includes(mode)) return null;
  const dir = join(xdgConfigHome(), 'ponytail');
  const file = ponytailFileConfig();
  file.defaultMode = mode;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(file, null, 2), 'utf8');
    return mode;
  } catch {
    return null;
  }
}

// caveman defaults live in the plugin config (/settings), not a side file.
function cavemanDefaultLevel(config) {
  return config.cavemanDefaultLevel;
}

function cavemanShowStatus(config) {
  return config.cavemanShowStatus;
}

// ---------------------------------------------------------------------------
// Ponytail instructions (verbatim port of hooks/ponytail-instructions.js).
// The skill body comes from the installed ponytail skill in the DSH user
// skill roots ($DSH_HOME/skills, then $DSH_AGENTS_HOME|~/.agents/skills,
// where `npx skills add -g` puts it).
// ---------------------------------------------------------------------------

export function ponytailSkillPaths(env = process.env) {
  return [
    join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'skills', 'ponytail', 'SKILL.md'),
    join(env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills', 'ponytail', 'SKILL.md'),
  ];
}

function readPonytailSkill() {
  for (const path of ponytailSkillPaths()) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      // try the next root
    }
  }
  throw new Error('ponytail skill not installed');
}

export function filterSkillBodyForMode(body, mode) {
  const effectiveMode = PONYTAIL_MODES.includes(mode) ? mode : 'full';
  const withoutFrontmatter = String(body || '').replace(/^---[\s\S]*?---\s*/, '');
  return withoutFrontmatter
    .split(/\r?\n/)
    .filter((line) => {
      const tableLabel = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
      if (tableLabel) {
        const labelMode = PONYTAIL_MODES.includes(tableLabel[1].trim().toLowerCase())
          ? tableLabel[1].trim().toLowerCase() : null;
        if (labelMode) return labelMode === effectiveMode;
      }
      const exampleLabel = line.match(/^-\s*([^:]+):\s*"/);
      if (exampleLabel) {
        const labelMode = PONYTAIL_MODES.includes(exampleLabel[1].trim().toLowerCase())
          ? exampleLabel[1].trim().toLowerCase() : null;
        if (labelMode) return labelMode === effectiveMode;
      }
      return true;
    })
    .join('\n');
}

function ponytailFallbackInstructions(mode) {
  return 'PONYTAIL MODE ACTIVE — level: ' + mode + '\n\n' +
    'You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.\n\n' +
    '## Persistence\n\n' +
    'ACTIVE EVERY RESPONSE. No drift back to over-building. Still active if unsure. Off only: "stop ponytail" / "normal mode".\n\n' +
    'Current level: **' + mode + '**. Switch: `/ponytail lite|full|ultra`.\n\n' +
    '## The ladder\n\n' +
    'Before any code, stop at the first rung that holds (the ladder runs after you understand the problem, not instead of it — read the code it touches and trace the real flow first):\n' +
    '1. Does this need to be built at all? (YAGNI)\n' +
    '2. Does it already exist in this codebase? Reuse what is already here, do not re-write it.\n' +
    '3. Does the standard library do this? Use it.\n' +
    '4. Does a native platform feature cover it? Use it.\n' +
    '5. Does an already-installed dependency solve it? Use it.\n' +
    '6. Can this be one line? Make it one line.\n' +
    '7. Only then: write the minimum code that works.\n\n' +
    'Bug fix = root cause, not symptom: grep every caller of the function you touch and fix the shared function once (a smaller diff than one guard per caller); patching only the path the ticket names leaves a sibling caller broken.\n\n' +
    '## Rules\n\n' +
    'No abstractions that were not requested. No avoidable dependencies. No boilerplate nobody asked for. ' +
    'Deletion over addition. Boring over clever. Fewest files possible. ' +
    'Ship the lazy version and question the complex request in the same response — never stall. ' +
    'Between two same-size stdlib options, pick the one correct on edge cases. ' +
    'Mark deliberate simplifications that cut a real corner with a known ceiling, using a `ponytail:` comment that names the ceiling and upgrade path.\n\n' +
    '## Output\n\n' +
    'Code first. Then at most three short lines: what was skipped, when to add it. ' +
    'If the explanation is longer than the code, delete the explanation. ' +
    'Explanation the user explicitly asked for is not debt, give it in full.\n\n' +
    '## When NOT to be lazy\n\n' +
    'Never simplify away: understanding the problem (read it fully and trace the real flow before picking a rung — a small diff you do not understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, ' +
    'security measures, accessibility basics, the calibration real hardware needs (the platform is never the spec ideal), anything the user explicitly asked to keep. ' +
    'Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind (assert-based demo/self-check or one small test file; no frameworks). Trivial one-liners need no test.\n\n' +
    '## Boundaries\n\n' +
    'Ponytail governs what you build, not how you talk. "stop ponytail" or "normal mode": revert. Level persists until changed or session end.';
}

export function getPonytailInstructions(mode) {
  // ponytail-instructions.js: persisted 'review' is a standalone mode with no
  // skill body; runtime modes filter the synced SKILL.md.
  if (mode === 'review') {
    return 'PONYTAIL MODE ACTIVE — level: review. Behavior defined by /ponytail-review skill.';
  }
  const configuredMode = PONYTAIL_MODES.includes(mode) && mode !== 'off' ? mode : 'full';
  try {
    return 'PONYTAIL MODE ACTIVE — level: ' + configuredMode + '\n\n' +
      filterSkillBodyForMode(readPonytailSkill(), configuredMode);
  } catch {
    return ponytailFallbackInstructions(configuredMode);
  }
}

// ponytail-config.js: standalone whole-message deactivation only.
function isDeactivationCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?\s]+$/, '');
  return t === 'stop ponytail' || t === 'normal mode';
}

// ---------------------------------------------------------------------------
// Caveman prompt fragments (verbatim port of caveman.ts)
// ---------------------------------------------------------------------------

const CAVEMAN_BASE = `\
IMPORTANT: You are in CAVEMAN MODE. Respond terse like smart caveman. \
All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically/actually/simply), \
pleasantries, hedging
- Fragments OK. Short synonyms preferred. Technical terms exact
- Code blocks unchanged. Errors quoted exact
- Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`;

const MICRO_PROMPT = `# Token efficiency
Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].`;

const CAVEMAN_INTENSITY = {
  lite: `\
No filler/hedging. Keep articles + full sentences. Professional but tight.
Example: "Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."`,

  full: `\
Drop articles, fragments OK, short synonyms.
Example: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."`,

  ultra: `\
Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y).
Example: "Inline obj prop → new ref → re-render. \`useMemo\`."`,

  'wenyan-lite': `\
Semi-classical Chinese. Grammar intact, filler gone. Technical terms in English.
Example: "組件頻重繪，以每繪新生對象參照故。以 useMemo 包之。"`,

  wenyan: `\
Maximum classical terseness. 80-90% character reduction. Technical terms in English.
Example: "物出新參照，致重繪。useMemo Wrap之。"`,

  'wenyan-ultra': `\
Extreme classical compression. Technical terms in English.
Example: "新參照→重繪。useMemo Wrap。"`,
};

const CAVEMAN_SAFETY = `\
Auto-clarity: drop caveman for security warnings, irreversible action confirmations, \
or when user is confused. Resume after.
Boundaries: write normal code. Only compress explanations. "stop caveman" or "normal mode" reverts.`;

function cavemanPrompt(level) {
  if (level === 'micro') return MICRO_PROMPT;
  return `${CAVEMAN_BASE}\n\n${CAVEMAN_INTENSITY[level]}\n\n${CAVEMAN_SAFETY}`;
}

// ---------------------------------------------------------------------------
// Caveman status animation — campfire frames verbatim from caveman.ts.
// Rendered via ctx.tuiStatus (the TUI's keyed status-line seam).
// ---------------------------------------------------------------------------

const R = '[38;5;196m';
const O = '[38;5;208m';
const Y = '[38;5;220m';
const W = '[38;5;230m';
const E = '[38;5;52m';
const X = '[0m';

const FIRE_FRAMES = [
  `${R}⠠${O}⠄${X}`,
  `${O}⠔${Y}⠂${X}`,
  `${Y}⠊${W}⠑${X}`,
  `${W}⠑${Y}⠊${X}`,
  `${Y}⠂${O}⠔${X}`,
  `${O}⠄${R}⠠${X}`,
  `${R}⠠${E}⠄${X}`,
  `${E}⠔${R}⠂${X}`,
];

const CAVEMAN_ANIMATIONS = {
  lite: { label: 'LITE', interval: 300 },
  full: { label: 'FULL', interval: 200 },
  ultra: { label: 'ULTRA', interval: 100 },
  'wenyan-lite': { label: '文言', interval: 300 },
  wenyan: { label: '文言文', interval: 200 },
  'wenyan-ultra': { label: '文言文極', interval: 100 },
  micro: { label: 'MICRO', interval: 120 },
};

const PONYTAIL_ICONS = { lite: '🌿', full: '⚡', ultra: '🔥' };

// ---------------------------------------------------------------------------
// Session-state persistence: Pi used sessionManager custom entries; the DSH
// equivalent is a typed plugin event appended to the session log (ignorable
// to older readers, log-only, no surface intent).
// ---------------------------------------------------------------------------

export const SESSION_EVENT_TYPES = ['dsh-caveman/caveman-level', 'dsh-caveman/ponytail-mode'];

/** session.append() cannot set `ignorable`, and persisted readers refuse unknown
 *  non-ignorable types (whole session unreadable: resume, session search).
 *  Register ours in every reachable dsh-session copy, as dsh-cache-tools does. */
export function registerSessionEventTypes(anchors = [import.meta.url, process.argv[1]]) {
  const done = new Set();
  const add = (req) => {
    try {
      const resolved = req.resolve('@deepseek-ai/dsh-session');
      let key = resolved;
      try { key = realpathSync(resolved); } catch { /* keep resolved */ }
      if (done.has(key)) return;
      done.add(key);
      const known = req(resolved).KNOWN_SESSION_EVENT_TYPES;
      for (const type of SESSION_EVENT_TYPES) known?.add(type);
    } catch { /* not reachable */ }
  };
  for (const anchor of anchors.filter((a) => typeof a === 'string' && a.length > 0)) {
    let req;
    try { req = createRequire(anchor); } catch { continue; }
    add(req);
    try { add(createRequire(req.resolve('@deepseek-ai/dsh-session-persistence'))); } catch { /* absent */ }
  }
  return done.size;
}

function lastCustomLevel(session, eventType, key) {
  try {
    const events = session.snapshotEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === eventType && e.data && typeof e.data[key] === 'string') {
        return e.data[key];
      }
    }
  } catch { /* session API drifted: fall back to configured default */ }
  return null;
}

function appendCustomLevel(session, eventType, key, value) {
  try {
    session.append(eventType, { [key]: value });
  } catch { /* unknown event types may be refused by older session builds */ }
}

// ---------------------------------------------------------------------------
// TUI seams — all optional (absent under headless/web hosts)
// ---------------------------------------------------------------------------

function tuiStatus(ctx) {
  try { return ctx.get('tuiStatus'); } catch { return undefined; }
}
function tuiToast(ctx) {
  try { return ctx.get('tuiToast'); } catch { return undefined; }
}
function tuiPluginHost(ctx) {
  try { return ctx.get('tuiPluginHost'); } catch { return undefined; }
}

/** Register a slash command through the mediated host surface when available
 * (stamps owner identity for the invoke checkpoint); direct registry
 * otherwise — unattributed commands use the root grant, the documented
 * trusted-in-process boundary. */
function registerCommand(ctx, def) {
  const host = tuiPluginHost(ctx);
  if (host && typeof host.registerCommand === 'function') {
    try { return host.registerCommand(ctx, def); }
    catch (err) {
      // Manifest contribution mismatch (e.g. stale dsh-plugin.json): fall back
      // to direct registration rather than losing the command entirely.
      ctx.logger('dsh-caveman').warn(`mediated command registration for /${def.name} failed; using direct registry`, err);
    }
  }
  return ctx.commands.register(def);
}

// ---------------------------------------------------------------------------
// rtk: rewrite `bash -c <cmd>` through `rtk rewrite` (rtk.ts port).
// DSH hook compat lacks PreToolUse.updatedInput; the real seam is a wrapper on
// ctx.shell.execute — the spawn boundary LocalBashExecutor.executeArgv reaches
// with the exact argv. Rewriting spec.command there is identical in effect to
// Pi's input mutation.
// ---------------------------------------------------------------------------

const RTK_TIMEOUT_MS = 2000;
const RTK_MIN_MINOR = 23;

function parseSemver(raw) {
  const m = String(raw).trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

async function rtkExec(ctx, args, signal) {
  const subprocess = ctx.get('subprocess');
  if (!subprocess || typeof subprocess.spawn !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('rtk timeout')), RTK_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const handle = subprocess.spawn({
      argv: ['rtk', ...args],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 500,
      signal: controller.signal,
    });
    const outcome = await handle.done.catch(() => null);
    const text = handle.collected?.stdout?.readFrom ? (handle.collected.stdout.readFrom(0).text ?? '') : '';
    return { code: outcome?.exitCode ?? null, killed: outcome?.signal != null, stdout: text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function rtkRewrite(ctx, cmd, signal) {
  const result = await rtkExec(ctx, ['rewrite', cmd], signal);
  if (!result || result.killed) return null;
  if (result.code !== 0 && result.code !== 3) return null;
  const out = result.stdout.trim();
  return out || null;
}

/** Probe `rtk --version`; returns { ok, reason }. */
async function probeRtk(ctx) {
  const ver = await rtkExec(ctx, ['--version']);
  if (!ver || ver.code !== 0) return { ok: false, reason: 'rtk binary not found in PATH' };
  const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ''));
  if (parsed && parsed[0] === 0 && parsed[1] < RTK_MIN_MINOR) {
    return { ok: false, reason: `rtk ${parsed.join('.')} is too old (need >= 0.${RTK_MIN_MINOR}.0)` };
  }
  return { ok: true };
}

/**
 * Wrap ctx.shell.execute so every bash spec runs `rtk rewrite` on
 * spec.command before the spawn. resolve() and the executor's own
 * deadline/sandbox/env semantics are untouched. Exported for tests.
 */
export function wrapShellForRtk(ctx, shell, rewrite) {
  const original = shell.execute.bind(shell);
  shell.execute = async (spec) => {
    try {
      const cmd = spec?.command;
      if (typeof cmd === 'string' && cmd.trim() !== '' && !cmd.startsWith('rtk ') && process.env.RTK_DISABLED !== '1') {
        const rewritten = await rewrite(cmd, spec.signal);
        if (rewritten && rewritten !== cmd) {
          return original({ ...spec, command: rewritten });
        }
      }
    } catch {
      // Fail open: never block execution on an unexpected error.
    }
    return original(spec);
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  registerSessionEventTypes();
  const logger = ctx.logger('dsh-caveman');

  // ---- shared session-scoped state -----------------------------------------
  let cavemanLevel = 'off';
  let ponytailMode = 'off';
  let cavemanActive = false;
  let ponytailActive = false;
  let cavemanTimer = null;
  let cavemanFrame = 0;
  let configuredPonytailDefault = ponytailDefaultMode(config);
  const configuredCavemanDefault = cavemanDefaultLevel(config);
  const showCavemanStatus = cavemanShowStatus(config);
  const hidePonytailStatus = ponytailHideStatus(config);
  const quietPonytailStartup = ponytailQuietStartup(config);

  const notify = (text, color) => {
    const toast = tuiToast(ctx);
    if (toast) toast.show(text, color ? { color } : undefined);
  };

  const syncCavemanStatus = () => {
    const status = tuiStatus(ctx);
    if (!status) return;
    if (cavemanTimer) { clearInterval(cavemanTimer); cavemanTimer = null; }
    cavemanFrame = 0;
    if (cavemanLevel === 'off' || !showCavemanStatus) { status.set('caveman', undefined); return; }
    const anim = CAVEMAN_ANIMATIONS[cavemanLevel];
    const render = () => {
      status.set('caveman', `${FIRE_FRAMES[cavemanFrame % FIRE_FRAMES.length]} caveman level: ${anim.label}`);
      cavemanFrame++;
    };
    render();
    if (cavemanActive) cavemanTimer = setInterval(render, anim.interval);
  };

  const syncPonytailStatus = () => {
    // ponytail: hidden indicator = no status calls at all (pi-extension syncStatus
    // returns before touching ctx.ui.setStatus), so absence must not record a write.
    if (hidePonytailStatus) return;
    const status = tuiStatus(ctx);
    if (!status) return;
    if (ponytailMode === 'off') { status.set('ponytail', undefined); return; }
    const icon = PONYTAIL_ICONS[ponytailMode] || '';
    const dot = ponytailActive ? '●' : '○';
    status.set('ponytail', `${dot} 🐴 ponytail: ${icon} ${ponytailMode.toUpperCase()}`);
  };

  const setCavemanLevel = (level, session) => {
    cavemanLevel = level;
    if (session) appendCustomLevel(session, 'dsh-caveman/caveman-level', 'level', level);
    syncCavemanStatus();
    notify(level === 'off' ? 'Caveman mode off.' : `Caveman: ${CAVEMAN_ANIMATIONS[level].label}`, 'success');
  };

  const setPonytailMode = (mode, session, silent) => {
    ponytailMode = mode;
    if (session) appendCustomLevel(session, 'dsh-caveman/ponytail-mode', 'mode', mode);
    syncPonytailStatus();
    if (!silent) notify(`Ponytail mode set to ${mode}.`, 'success');
  };

  // ---- system-prompt sections ------------------------------------------------
  // Dynamic providers: empty section text is dropped by renderPrompt, so the
  // prompt gains rules only while the mode is on. Order 200 sits between the
  // persona prefix (0) and tool guidance (1000+), matching Pi's append-at-end.
  ctx.systemPrompt.section({
    name: 'dsh-caveman:caveman',
    order: 200,
    interpolate: false,
    text: () => (cavemanLevel === 'off' ? '' : cavemanPrompt(cavemanLevel)),
  });
  ctx.systemPrompt.section({
    name: 'dsh-caveman:ponytail',
    order: 201,
    interpolate: false,
    text: () => (ponytailMode === 'off' ? '' : getPonytailInstructions(ponytailMode)),
  });

  // ---- agent lifecycle -------------------------------------------------------
  // Pi session_start → agent/created (covers fresh create and resume).
  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session;
    const savedCaveman = lastCustomLevel(session, 'dsh-caveman/caveman-level', 'level');
    const savedPonytail = lastCustomLevel(session, 'dsh-caveman/ponytail-mode', 'mode');
    cavemanLevel = savedCaveman && CAVEMAN_LEVELS.includes(savedCaveman) ? savedCaveman : configuredCavemanDefault;
    ponytailMode = savedPonytail && PONYTAIL_MODES.includes(savedPonytail) ? savedPonytail : configuredPonytailDefault;
    if (!savedCaveman && cavemanLevel !== 'off') appendCustomLevel(session, 'dsh-caveman/caveman-level', 'level', cavemanLevel);
    if (!savedPonytail && ponytailMode !== 'off') appendCustomLevel(session, 'dsh-caveman/ponytail-mode', 'mode', ponytailMode);
    syncCavemanStatus();
    syncPonytailStatus();
    if (!quietPonytailStartup) notify(`Ponytail loaded: ${ponytailMode}`, 'success');
  });

  // Pi agent_start/agent_end → agent/status transitions.
  ctx.on('agent/status', ({ status }) => {
    const running = status === 'running';
    cavemanActive = running;
    ponytailActive = running;
    syncCavemanStatus();
    syncPonytailStatus();
  });

  // ponytail: whole-message "stop ponytail" / "normal mode" deactivates.
  // Pi hooked the pre-delivery `input` event; the dsh-TUI equivalent is the
  // mediated `tui/input` decision point (fires on submit+steer BEFORE the text
  // enters the session — dsh-tui/lib/types/dsh-adapter/extension-events.d.ts).
  // It needs the `session.input.intercept` grant declared in dsh-plugin.json and
  // granted in ~/.dsh-tui/extension-grants.json (default deny). On hosts without
  // the dispatch topology the subscription silently never fires, so we ALSO keep
  // an `agent/inbox/inserted` observer as the model-agnostic fallback. Both paths
  // are idempotent: setting mode 'off' twice is harmless.
  let hasInputDecision = false;
  try {
    ctx.on('tui/input', (event) => {
      if (ponytailMode === 'off') return undefined;
      const text = String(event?.text || '');
      if (!isDeactivationCommand(text)) return undefined;
      setPonytailMode('off', undefined, true);
      // Pi kept the line flowing to the model; the DSH decision point cannot
      // deliver-but-mutate, so `handled` + notice is the closest faithful
      // behavior (documented divergence in BEHAVIOR.md).
      return { handled: true, notice: 'Ponytail mode set to off.' };
    });
    hasInputDecision = true;
  } catch (err) {
    logger.warn('tui/input subscription failed; inbox fallback covers deactivation', err);
  }
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    // Belt-and-suspenders: when the TUI decision layer handled the line first
    // the mode is already 'off', so this check is a harmless no-op; when the
    // decision dispatch topology is absent (headless host, missing grant) the
    // inbox insert still delivers the text to the model — matching Pi, where
    // the line always reached the model after deactivating.
    if (ponytailMode === 'off') return;
    if (isDeactivationCommand(extractText(message))) setPonytailMode('off', agent.session, true);
  });

  // ---- /abort (pi-abort-command port) ----------------------------------------
  registerCommand(ctx, {
    name: 'abort',
    description: 'Abort the current agent operation',
    handler: (invocation) => {
      invocation.agent.cancel({ kind: 'user' });
      return { kind: 'success', text: 'Aborted.' };
    },
  });

  // ---- /caveman ---------------------------------------------------------------
  registerCommand(ctx, {
    name: 'caveman',
    description: 'Toggle caveman mode: off/lite/full/ultra/wenyan-lite/wenyan/wenyan-ultra/micro, stop, or config',
    input: { hint: 'level, stop, or config' },
    handler: (invocation) => {
      const arg = (invocation.rawInput || '').trim().toLowerCase();
      const session = invocation.agent.session;
      if (arg === 'config') {
        return { kind: 'success', text: `Caveman config: level=${cavemanLevel} default=${configuredCavemanDefault} status=${showCavemanStatus ? 'on' : 'off'} — set defaults via /settings (dsh-caveman).` };
      }
      if (!arg) {
        setCavemanLevel(cavemanLevel === 'off' ? 'full' : 'off', session);
        return { kind: 'success' };
      }
      if (arg === 'off' || arg === 'stop' || arg === 'quit') {
        setCavemanLevel('off', session);
        return { kind: 'success' };
      }
      if (CAVEMAN_LEVELS.includes(arg)) {
        setCavemanLevel(arg, session);
        return { kind: 'success' };
      }
      return { kind: 'error', text: `Unknown: "${arg}". Use: ${CAVEMAN_LEVELS.join(', ')}, stop, quit, or config` };
    },
  });

  // ---- /ponytail --------------------------------------------------------------
  registerCommand(ctx, {
    name: 'ponytail',
    description: 'Set mode: off|lite|full|ultra. Commands: status, default <mode>',
    input: { hint: 'mode, status, or default <mode>' },
    handler: (invocation) => {
      const arg = (invocation.rawInput || '').trim().toLowerCase();
      const session = invocation.agent.session;
      const [primary, secondary] = arg.split(/\s+/);
      if (!primary) {
        setPonytailMode(ponytailMode === 'off' ? (configuredPonytailDefault === 'off' ? 'full' : configuredPonytailDefault) : 'off', session);
        return { kind: 'success' };
      }
      if (primary === 'status') {
        return { kind: 'success', text: `Ponytail: current ${ponytailMode} • default ${configuredPonytailDefault}` };
      }
      if (primary === 'default') {
        const mode = PONYTAIL_MODES.includes(secondary) ? secondary : null;
        if (!mode) return { kind: 'error', text: 'Invalid default mode. Use off|lite|full|ultra.' };
        const written = writePonytailDefaultMode(mode);
        if (written) {
          configuredPonytailDefault = ponytailDefaultMode(config);
          return { kind: 'success', text: configuredPonytailDefault === written ? `Default Ponytail mode set to ${written}.` : `Saved default ${written}, but env override keeps default at ${configuredPonytailDefault}.` };
        }
        return { kind: 'error', text: 'Failed to save default mode.' };
      }
      if (PONYTAIL_MODES.includes(primary)) {
        setPonytailMode(primary, session);
        return { kind: 'success' };
      }
      return { kind: 'error', text: 'Unknown or unsupported /ponytail mode.' };
    },
  });

  // ---- ponytail skill aliases ---------------------------------------------------
  // Pi sent "/skill:ponytail-*" as a user message (sendUserMessage; followUp
  // when busy). DSH agent.followup is the same observable seam: an ordinary
  // next-turn user message carrying the skill line.
  for (const [cmd, skill] of [
    ['ponytail-review', '/skill:ponytail-review'],
    ['ponytail-audit', '/skill:ponytail-audit'],
    ['ponytail-gain', '/skill:ponytail-gain'],
    ['ponytail-debt', '/skill:ponytail-debt'],
    ['ponytail-help', '/skill:ponytail-help'],
  ]) {
    registerCommand(ctx, {
      name: cmd,
      description: `Run ${skill}`,
      input: { hint: 'optional extra args' },
      handler: (invocation) => {
        const extra = (invocation.rawInput || '').trim();
        const text = extra ? `${skill} ${extra}` : skill;
        invocation.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }));
        return { kind: 'success', text: `${skill} queued.` };
      },
    });
  }

  // ---- rtk ----------------------------------------------------------------------
  // Optional peers (`shell`, `subprocess`) mount via a sub-fiber that activates
  // once both services exist; hosts without them keep rtk a disabled no-op
  // (fail-open, like the Pi original's missing-binary path).
  const startRtk = (rtkCtx) => {
    if (!config.rtkEnabled || !rtkCtx.get('shell')) return;
    probeRtk(rtkCtx).then((res) => {
      if (!res.ok) {
        logger.warn(`rtk disabled: ${res.reason}`);
        const status = tuiStatus(rtkCtx);
        if (status) status.set('rtk', `RTK disabled: ${res.reason}`);
        return;
      }
      wrapShellForRtk(rtkCtx, rtkCtx.get('shell'), (cmd, signal) => rtkRewrite(rtkCtx, cmd, signal));
      logger.info('rtk bash rewrite enabled');
    }).catch((err) => logger.warn('rtk probe failed', err));
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['shell', 'subprocess'], startRtk);
  } else {
    // Test fakes / minimal hosts without sub-fiber support.
    startRtk(ctx);
  }
}

/** Pull plain text out of a DSH UserMessage (string or block array). */
function extractText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && b.type === 'text' ? b.text : '')).join('');
  }
  return '';
}

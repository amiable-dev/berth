// @ts-check
/**
 * berth ui — dashboard client.
 *
 * Plain ES2022 module, no imports, no dependencies. Polls GET /api/state (the
 * shape of `berth check --json`) every 5 s and falls back to
 * ./fixtures/check.sample.json when the API is unreachable, so the page also
 * works opened from disk or from any static file server. All DOM is built
 * with createElement/textContent; server data is never parsed as HTML.
 */

/** @typedef {'ok'|'idle'|'stale'|'orphan'|'unmanaged'|'squatter'|'conflict'|'drift'} State */
/** @typedef {'block'|'dynamic'|'declared'|'shared'} Kind */
/** @typedef {'sessions'|'table'|'map'|'rules'|'term'} View */

/**
 * @typedef {object} Owner
 * @property {string} [session_id]
 * @property {'claude-code'|'human'|'macos'|'unknown'} tool
 * @property {number} [pid]
 * @property {number} [pid_start]
 */
/**
 * @typedef {object} Lease
 * @property {number} port
 * @property {string} project
 * @property {number} worktree
 * @property {string} role
 * @property {Kind} kind
 * @property {Owner} owner
 * @property {string} cwd
 * @property {string} created
 * @property {string|null} [expires]
 * @property {string} [note]
 */
/**
 * @typedef {object} Live
 * @property {string} holder
 * @property {number} [pid]
 * @property {string} [container]
 * @property {string} [cwd]
 * @property {string} [sessionId]
 * @property {string} [tool]
 * @property {boolean} [proxy]
 */
/**
 * @typedef {object} PortRecord
 * @property {number} port
 * @property {State} state
 * @property {string} [project]
 * @property {number} [worktree]
 * @property {string} [role]
 * @property {Kind} [kind]
 * @property {{P: number, W: number, R: number}|null} decoded
 * @property {Lease|null} lease
 * @property {Live|null} live
 * @property {string[]} evidence
 * @property {{text: string, command?: string}|null} advisory
 * @property {string} [url]
 * @property {string} [age]
 */
/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} short
 * @property {string} tool
 * @property {number} [pid]
 * @property {string} [started]
 * @property {string|null} [ended]
 * @property {boolean} alive
 * @property {string} [project]
 * @property {number} [worktree]
 * @property {string} [cwd]
 * @property {boolean} cwdExists
 * @property {number[]} leases
 * @property {State} worst
 * @property {string[]} howWeKnow
 */
/**
 * @typedef {object} Project
 * @property {string} name
 * @property {number} P
 * @property {string} path
 * @property {number} base
 * @property {number[]} declared
 * @property {Record<string, number>} extras
 * @property {string} [note]
 */
/**
 * @typedef {object} Policy
 * @property {{base: number, projectMax: number, worktreeMax: number, roles: Record<string, number>}} scheme
 * @property {{dynamic: [number, number], ttlHours: number}} pools
 * @property {{ranges: [number, number][], ports: number[], lint: number[]}} reserved
 * @property {Record<string, {owner: string, ports: Record<string, number>, note?: string}>} shared
 * @property {Project[]} projects
 */
/**
 * @typedef {object} CheckReport
 * @property {string} version
 * @property {string} generatedAt
 * @property {number} cacheAgeMs
 * @property {{platform: string, user: string, dockerAvailable: boolean, colima: boolean}} host
 * @property {Policy} policy
 * @property {PortRecord[]} ports
 * @property {SessionRecord[]} sessions
 * @property {{ports: number, attention: number, liveSessions: number, byState: Record<State, number>}} summary
 */

// ---------------------------------------------------------------------------
// constants

/** @type {readonly State[]} */
const STATES = Object.freeze([
  'ok',
  'idle',
  'stale',
  'orphan',
  'unmanaged',
  'squatter',
  'conflict',
  'drift',
]);
/** Severity order, worst first. */
const SEVERITY = [...STATES].reverse();
const HATCHED = new Set(['squatter', 'stale', 'conflict', 'orphan']);
/** @type {readonly View[]} */
const VIEWS = Object.freeze(['sessions', 'table', 'map', 'rules', 'term']);
/** Advisory copy per state (exact, from the handoff); used when the server omits `advisory`. */
/** @type {Record<State, {text: string, command?: string}>} */
const ADVICE = {
  ok: { text: 'none' },
  idle: { text: 'none — shown dimmed' },
  stale: {
    text: 'Owner pid is gone. Suggest release; berth never auto-kills.',
    command: 'berth release --port {p}',
  },
  orphan: {
    text: 'Lease cwd no longer exists. Suggest release; tombstone keeps the worktree ID.',
    command: 'berth release --port {p}',
  },
  unmanaged: {
    text: 'Bound inside a managed range with no lease and no session marker.',
    command: 'berth adopt {p} --owner human',
  },
  squatter: {
    text: 'A different session bound a port inside another project’s block. Name the holder and the block owner; do not kill.',
    command: 'berth who {p}',
  },
  conflict: {
    text: 'Lease owner differs from the live holder. Tell the owning session its belief is wrong.',
    command: 'berth who {p} --json',
  },
  drift: {
    text: 'Config declares a port outside its allocation, or a labelled service vanished. Never reassign.',
    command: 'berth scan --write',
  },
};
const API_URL = '/api/state';
const FIXTURE_URL = './fixtures/check.sample.json';
const POLL_MS = 5000;
const FETCH_TIMEOUT_MS = 4000;
const THEME_KEY = 'berth.theme';
const LEGACY_MIN = 1024;
const LEGACY_MAX = 9999;
/** Block-scheme fallbacks, used only when a report omits a `policy.scheme` field. */
const DEFAULT_SCHEME = Object.freeze({ base: 10000, projectMax: 29, worktreeMax: 9 });
const LANDMARKS = [1024, 3000, 4000, 5000, 5432, 6379, 8000, 9090, 9999];
/** @type {Record<number, string>} */
const RESERVED_LABEL = { 0: 'privileged', 4000: 'portless', 49152: 'macOS ephemeral' };
/** @type {Record<number, string>} */
const LINT_NAME = {
  11211: 'memcached',
  11434: 'Ollama',
  15672: 'RabbitMQ',
  16686: 'Jaeger',
  19999: 'netdata',
  27017: 'Mongo',
};

// ---------------------------------------------------------------------------
// state

/**
 * @typedef {object} UiState
 * @property {View} view
 * @property {string|null} selectedSession
 * @property {string} query
 * @property {Set<State>} stateFilters
 * @property {string} projectFilter
 * @property {number|null} drawerPort
 * @property {boolean} polling
 * @property {number} lastCheckedAt  epoch ms of the last successful load, 0 = never
 * @property {number} lastAttemptAt
 * @property {boolean} offline
 * @property {'none'|'live'|'fixture'} source
 * @property {boolean} copied
 * @property {'dark'|'light'} theme
 */
/** @type {UiState} */
const ui = {
  view: 'sessions',
  selectedSession: null,
  query: '',
  stateFilters: new Set(),
  projectFilter: '',
  drawerPort: null,
  polling: true,
  lastCheckedAt: 0,
  lastAttemptAt: 0,
  offline: false,
  source: 'none',
  copied: false,
  theme: 'dark',
};

/** @type {CheckReport|null} */
let data = null;

/**
 * Indexes rebuilt whenever `data` changes, plus the block scheme read from `policy`:
 * `base` is the first block port, `blockEnd` the first port past the last block
 * (base + 1000·(projectMax + 1)), `dynamic` the inclusive dynamic-pool bounds.
 * @type {{byPort: Map<number, PortRecord>, sessionOfPort: Map<number, SessionRecord>, projectByName: Map<string, Project>, projectByP: Map<number, Project>, roleName: Map<number, string>, home: string, base: number, blockEnd: number, projectMax: number, worktreeMax: number, dynamic: [number, number], ttlHours: number}}
 */
let idx = {
  byPort: new Map(),
  sessionOfPort: new Map(),
  projectByName: new Map(),
  projectByP: new Map(),
  roleName: new Map(),
  home: '',
  base: DEFAULT_SCHEME.base,
  blockEnd: DEFAULT_SCHEME.base + 1000 * (DEFAULT_SCHEME.projectMax + 1),
  projectMax: DEFAULT_SCHEME.projectMax,
  worktreeMax: DEFAULT_SCHEME.worktreeMax,
  dynamic: [0, 0],
  ttlHours: 8,
};

/** Fingerprint of the last rendered report (see `fingerprintOf`); '' until the first load. */
let fingerprint = '';

/** @type {ReturnType<typeof setTimeout>|null} */
let copiedTimer = null;

// ---------------------------------------------------------------------------
// DOM helpers

/**
 * @typedef {Node|string|number|null|undefined|false} Child
 * @param {string} tag
 * @param {Record<string, unknown>|null} [attrs]
 * @param {...(Child|Child[])} children
 * @returns {HTMLElement}
 */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key.startsWith('on') && typeof value === 'function')
        node.addEventListener(key.slice(2), /** @type {EventListener} */ (value));
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

/**
 * @param {Node} node
 * @param {(Child|Child[])[]} children
 */
function appendChildren(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/** @param {Element} node */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** @param {string} id @returns {HTMLElement} */
function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

/** Make Enter/Space on a focusable non-button act like a click. @param {KeyboardEvent} ev */
function keyActivate(ev) {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    /** @type {HTMLElement} */
    (ev.currentTarget).click();
  }
}

/**
 * Selector identifying the focused element so focus survives a full re-render: static ids
 * (search, tabs), `data-port` rows and cells, `data-session` rail rows, `data-state` filter
 * chips, or one of the singleton controls that are rebuilt with the drawer/filters.
 * @returns {string|null}
 */
function focusKey() {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || a === document.body) return null;
  if (a.id) return `#${CSS.escape(a.id)}`;
  for (const key of ['port', 'session', 'state']) {
    const value = a.dataset[key];
    if (value != null) return `[data-${key}="${CSS.escape(value)}"]`;
  }
  for (const cls of ['dr-close', 'copy', 'psel', 'clear'])
    if (a.classList.contains(cls)) return `.${cls}`;
  return null;
}

/** @param {string|null} key  selector from `focusKey()` */
function restoreFocus(key) {
  if (!key) return;
  const node = document.querySelector(key);
  if (node instanceof HTMLElement) node.focus({ preventScroll: true });
}

/**
 * Text link for a URL from data. Only http(s) URLs become anchors; anything else is inert text.
 * @param {string|undefined} url
 * @param {string} [empty]
 */
function urlLink(url, empty = '') {
  if (!url || !/^https?:\/\//i.test(url)) return empty;
  return el(
    'a',
    { href: url, target: '_blank', rel: 'noopener noreferrer' },
    url.replace(/^https?:\/\//i, ''),
  );
}

// ---------------------------------------------------------------------------
// data helpers

/** @param {string} s @returns {State} */
function asState(s) {
  return /** @type {State} */ (STATES.includes(/** @type {State} */ (s)) ? s : 'unmanaged');
}

/** @param {string|undefined|null} id */
function shortId(id) {
  return id && id.length > 8 ? id.slice(0, 8) : id || '—';
}

/** @param {string|undefined} tool */
function toolLabel(tool) {
  if (tool === 'claude-code' || tool === 'claude') return 'claude code';
  if (tool === 'macos') return 'macOS';
  return tool || 'unknown';
}

/** Collapse the host user's home directory to `~`. @param {string|undefined} path */
function tilde(path) {
  if (!path) return '';
  if (idx.home && path.startsWith(idx.home)) return '~' + path.slice(idx.home.length);
  return path;
}

/** @param {string|undefined|null} isoTime  @returns {string} HH:MM local, or a day marker when not today */
function fmtTime(isoTime) {
  if (!isoTime) return '—';
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return isoTime;
  const ref = data?.generatedAt ? new Date(data.generatedAt) : new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayDiff = Math.round((startOfDay(ref) - startOfDay(d)) / 86400000);
  if (dayDiff === 0) return hhmm;
  if (dayDiff === 1) return 'yesterday';
  return d.toISOString().slice(0, 10);
}

/** @param {Date} d */
function startOfDay(d) {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/** Age string like `0h 31m` / `2d 4h` from a timestamp, relative to generatedAt. @param {string} isoTime */
function ageSince(isoTime) {
  const t = new Date(isoTime).getTime();
  if (Number.isNaN(t)) return '—';
  const ref = data?.generatedAt ? new Date(data.generatedAt).getTime() : Date.now();
  const mins = Math.max(0, Math.floor((ref - t) / 60000));
  const h = Math.floor(mins / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** @param {PortRecord} r */
function ageOf(r) {
  return r.age || (r.lease ? ageSince(r.lease.created) : '—');
}

/**
 * Live holder as `holder pid N`, composed from the separate fields. The server may send the
 * bare command name (or `unknown process`) with `pid` alongside, a legacy string that already
 * embeds the pid (`node 9001 (next dev)`, `pid 9001`), or a container name; the pid is appended
 * only when the holder does not already mention it, and never for a container, whose `pid` is
 * the VM proxy's.
 * @param {PortRecord} r
 */
function holderOf(r) {
  const live = r.live;
  if (!live) return '—';
  let holder = (live.holder || '').trim();
  if (!holder || holder === 'unknown') holder = 'unknown process';
  if (live.container && holder === live.container) holder = `container ${holder}`;
  if (live.pid == null || live.container) return holder;
  const mentioned = holder.split(/[\s()]+/).includes(String(live.pid));
  return mentioned ? holder : `${holder} pid ${live.pid}`;
}

/** @param {PortRecord} r */
function cwdOf(r) {
  return tilde(r.lease?.cwd || r.live?.cwd || '');
}

/** @param {PortRecord} r */
function projectOf(r) {
  return r.project || r.lease?.project || '';
}

/**
 * Every project a record is attributed to: a shared or declared port's `project` may be a
 * comma-joined list of the declaring projects.
 * @param {PortRecord} r
 */
function projectsOf(r) {
  return projectOf(r)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @param {PortRecord} r */
function worktreeOf(r) {
  return r.worktree ?? r.lease?.worktree ?? r.decoded?.W ?? 0;
}

/** @param {PortRecord} r */
function roleOf(r) {
  return r.role || r.lease?.role || roleForPort(r.port, idx.projectByName.get(projectOf(r))) || '—';
}

/** @param {PortRecord} r */
function kindOf(r) {
  return r.kind || r.lease?.kind || '—';
}

/** @param {PortRecord} r */
function sessionOf(r) {
  return idx.sessionOfPort.get(r.port) || null;
}

/** Display label for the session that owns a record: short id for claude-code, tool name otherwise. @param {PortRecord} r */
function sessionLabel(r) {
  const s = sessionOf(r);
  if (s) return s.tool === 'claude-code' ? s.short : toolLabel(s.tool);
  const owner = r.lease?.owner;
  if (owner) return owner.session_id ? shortId(owner.session_id) : toolLabel(owner.tool);
  return '—';
}

/** First port of project P's block: the policy's own `base` when present, else from the scheme. @param {number} P @param {Project|undefined} [project] */
function baseOfP(P, project) {
  return typeof project?.base === 'number' ? project.base : idx.base + 1000 * P;
}

/** @param {Project} p */
function blockRange(p) {
  const base = baseOfP(p.P, p);
  return `${base}–${base + 999}`;
}

/**
 * Client-side P/W/R for a port inside the block range, parameterised by the scheme base.
 * Only for ports the server did not decode: empty map cells and declared/legacy ports.
 * @param {number} port
 * @returns {{P: number, W: number, R: number}|null}
 */
function decodeClient(port) {
  if (port < idx.base || port >= idx.blockEnd) return null;
  const off = port - idx.base;
  return { P: Math.floor(off / 1000), W: Math.floor((off % 1000) / 100), R: off % 100 };
}

/** @param {number} port @param {Project|undefined} project */
function roleForPort(port, project) {
  const d = decodeClient(port);
  if (!d) return '';
  const R = d.R;
  if (R < 10) return idx.roleName.get(R) || '';
  if (project) {
    const hit = Object.entries(project.extras || {}).find(([, slot]) => slot === R);
    if (hit) return hit[0];
  }
  return `extra ${String(R).padStart(2, '0')}`;
}

/**
 * Decode a port into P/W/R plus a sentence; mirrors `berth who`.
 * @param {number} port
 * @param {PortRecord|undefined} [r]
 * @returns {{P: number|string, W: number|string, R: number|string, text: string, block: boolean}}
 */
function decode(port, r) {
  const pools = idx.dynamic;
  const ttl = idx.ttlHours;
  const d = r?.decoded || decodeClient(port);
  if (d) {
    const project = idx.projectByP.get(d.P);
    const role = r?.role || r?.lease?.role || roleForPort(port, project) || 'extra';
    return {
      ...d,
      block: true,
      text: `project ${d.P}${project ? ` (${project.name})` : ''} · worktree ${d.W} · role ${String(d.R).padStart(2, '0')} ${role}`,
    };
  }
  const none = { P: '—', W: '—', R: '—', block: false };
  if (port >= pools[0] && port <= pools[1])
    return { ...none, text: `dynamic pool ${pools[0]}–${pools[1]} · TTL ${ttl} h` };
  if (port < 1024) return { ...none, text: 'privileged range, reserved' };
  if (port <= 9999)
    return {
      ...none,
      text: 'legacy range 1024–9999 · declared or reserved, outside the block scheme',
    };
  return { ...none, text: 'outside every managed range' };
}

/** Worst state across records, by severity. @param {PortRecord[]} recs @param {State} [fallback] */
function worstOf(recs, fallback = 'ok') {
  return SEVERITY.find((s) => recs.some((r) => r.state === s)) || fallback;
}

/** All records attributed to a session (unfiltered). @param {SessionRecord} s */
function recordsOf(s) {
  return (data?.ports || []).filter((r) => idx.sessionOfPort.get(r.port) === s);
}

/** @param {PortRecord} r */
function matches(r) {
  if (ui.stateFilters.size && !ui.stateFilters.has(r.state)) return false;
  if (ui.projectFilter && projectOf(r) !== ui.projectFilter) return false;
  const q = ui.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    r.port,
    projectOf(r),
    roleOf(r),
    holderOf(r),
    cwdOf(r),
    r.lease?.cwd,
    r.state,
    sessionLabel(r),
    r.lease?.owner.session_id ? shortId(r.lease.owner.session_id) : '',
    r.live?.pid,
    r.lease?.owner.pid,
    r.live?.container,
  ]
    .filter((v) => v != null && v !== '')
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

/** @returns {PortRecord[]} */
function visiblePorts() {
  return (data?.ports || []).filter(matches);
}

/** @param {State} s */
function countOf(s) {
  return (data?.ports || []).filter((r) => r.state === s).length;
}

/** Sorted policy projects. */
function projects() {
  return [...(data?.policy.projects || [])].sort((a, b) => a.P - b.P);
}

/** @returns {SessionRecord|null} */
function selectedSession() {
  const list = data?.sessions || [];
  return list.find((s) => s.id === ui.selectedSession) || list[0] || null;
}

/** Group visible records Project → rows, in P order; records with no policy project go last. @param {PortRecord[]} recs */
function groupByProject(recs) {
  /** @type {{name: string, project: Project|null, rows: PortRecord[]}[]} */
  const groups = [];
  for (const p of projects()) {
    const rows = recs
      .filter((r) => projectOf(r) === p.name)
      .sort((a, b) => worktreeOf(a) - worktreeOf(b) || a.port - b.port);
    if (rows.length) groups.push({ name: p.name, project: p, rows });
  }
  const rest = recs
    .filter((r) => !idx.projectByName.has(projectOf(r)))
    .sort((a, b) => a.port - b.port);
  if (rest.length) groups.push({ name: 'unassigned', project: null, rows: rest });
  return groups;
}

/** Rebuild lookup tables after data changes. @param {CheckReport} report */
function reindex(report) {
  const byPort = new Map(report.ports.map((r) => [r.port, r]));
  const sessionOfPort = new Map();
  const sessions = new Map(report.sessions.map((s) => [s.id, s]));
  for (const s of report.sessions)
    for (const p of s.leases || []) if (!sessionOfPort.has(p)) sessionOfPort.set(p, s);
  for (const r of report.ports) {
    const sid = r.lease?.owner.session_id;
    if (!sessionOfPort.has(r.port) && sid && sessions.has(sid))
      sessionOfPort.set(r.port, sessions.get(sid));
  }
  const projectByName = new Map(report.policy.projects.map((p) => [p.name, p]));
  const projectByP = new Map(report.policy.projects.map((p) => [p.P, p]));
  const roleName = new Map(
    Object.entries(report.policy.scheme.roles || {}).map(([name, R]) => [R, name]),
  );
  const user = report.host?.user || '';
  const home = user ? (report.host.platform === 'darwin' ? `/Users/${user}` : `/home/${user}`) : '';
  const scheme = report.policy.scheme || {};
  const base = typeof scheme.base === 'number' ? scheme.base : DEFAULT_SCHEME.base;
  const projectMax =
    typeof scheme.projectMax === 'number' ? scheme.projectMax : DEFAULT_SCHEME.projectMax;
  const worktreeMax =
    typeof scheme.worktreeMax === 'number' ? scheme.worktreeMax : DEFAULT_SCHEME.worktreeMax;
  const blockEnd = base + 1000 * (projectMax + 1);
  const pool = report.policy.pools?.dynamic;
  /** @type {[number, number]} */
  const dynamic =
    Array.isArray(pool) && pool.length === 2 ? [pool[0], pool[1]] : [blockEnd, blockEnd + 1999];
  const ttlHours = report.policy.pools?.ttlHours ?? 8;
  idx = {
    byPort,
    sessionOfPort,
    projectByName,
    projectByP,
    roleName,
    home,
    base,
    blockEnd,
    projectMax,
    worktreeMax,
    dynamic,
    ttlHours,
  };
}

/**
 * Content identity of a report with the per-poll `generatedAt`/`cacheAgeMs` left out, so a
 * poll that changed nothing does not rebuild the page.
 * @param {CheckReport} report
 */
function fingerprintOf(report) {
  const { version, host, policy, ports, sessions, summary } = report;
  return JSON.stringify({ version, host, policy, ports, sessions, summary });
}

// ---------------------------------------------------------------------------
// loading and polling

/**
 * @param {string} url
 * @returns {Promise<CheckReport>}
 */
async function fetchReport(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !Array.isArray(json.ports) || !Array.isArray(json.sessions) || !json.policy)
      throw new Error(`${url}: not a check report`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the live report; fall back to the fixture only while no live data has ever been seen. */
async function load() {
  ui.lastAttemptAt = Date.now();
  try {
    const report = await fetchReport(API_URL);
    setData(report, 'live');
    return;
  } catch (err) {
    if (ui.source === 'live') {
      ui.offline = true;
      renderHeaderStatus();
      return;
    }
  }
  try {
    const report = await fetchReport(FIXTURE_URL);
    setData(report, 'fixture');
  } catch (err) {
    ui.offline = true;
    renderHeaderStatus();
    if (!data) renderMain();
  }
}

/**
 * @param {CheckReport} report
 * @param {'live'|'fixture'} source
 */
function setData(report, source) {
  const print = fingerprintOf(report);
  const changed = print !== fingerprint;
  fingerprint = print;
  data = report;
  reindex(report);
  ui.source = source;
  ui.offline = false;
  ui.lastCheckedAt = Date.now();
  if (!changed) {
    // Same content as what is on screen: only the "Ns ago" label moves.
    renderHeaderStatus();
    return;
  }
  if (ui.drawerPort != null && !idx.byPort.has(ui.drawerPort)) ui.drawerPort = null;
  if (ui.projectFilter && !idx.projectByName.has(ui.projectFilter)) ui.projectFilter = '';
  render();
}

function tick() {
  renderHeaderStatus();
  if (ui.polling && Date.now() - ui.lastAttemptAt >= POLL_MS) void load();
}

// ---------------------------------------------------------------------------
// header, filters

function renderHeaderStatus() {
  const ago = byId('ago');
  const dot = byId('dot');
  const secs = ui.lastCheckedAt
    ? Math.min(99, Math.floor((Date.now() - ui.lastCheckedAt) / 1000))
    : 0;
  ago.textContent = ui.offline ? 'offline' : ui.polling ? `${secs}s ago` : 'manual';
  dot.classList.toggle('on', ui.polling);
  const pollBtn = byId('pollBtn');
  pollBtn.textContent = ui.polling ? 'poll on' : 'poll off';
  pollBtn.classList.toggle('on', ui.polling);
  pollBtn.classList.toggle('off', !ui.polling);
  pollBtn.setAttribute('aria-pressed', String(ui.polling));
  byId('fixtureTag').hidden = ui.source !== 'fixture';
  byId('themeBtn').textContent = ui.theme === 'dark' ? '☾' : '☼';
}

function renderTabs() {
  const nav = byId('tabs');
  clear(nav);
  const counts = {
    sessions: data?.sessions.length ?? '',
    table: data?.ports.length ?? '',
    map: '',
    rules: data?.policy.projects.length ?? '',
    term: '',
  };
  for (const v of VIEWS) {
    nav.appendChild(
      el(
        'button',
        {
          class: 'tab',
          type: 'button',
          role: 'tab',
          'aria-selected': String(ui.view === v),
          id: `tab-${v}`,
          onclick: () => {
            if (ui.view !== v) {
              ui.view = v;
              hideTip();
              renderTabs();
              renderMain();
            }
          },
        },
        v,
        el('span', { class: 'n' }, String(counts[v])),
      ),
    );
  }
}

function renderFilters() {
  const bar = byId('filters');
  clear(bar);
  const any = ui.stateFilters.size > 0;
  bar.classList.toggle('any', any);
  bar.appendChild(el('span', { class: 'lbl state' }, 'state'));
  for (const s of STATES) {
    const on = ui.stateFilters.has(s);
    bar.appendChild(
      el(
        'button',
        {
          class: `chip c-${s}${on ? ' on' : ''}`,
          type: 'button',
          'data-state': s,
          'aria-pressed': String(on),
          onclick: () => {
            if (on) ui.stateFilters.delete(s);
            else ui.stateFilters.add(s);
            renderFilters();
            renderMain();
          },
        },
        el('span', { class: `sw bg-${s}` }),
        s,
        el('span', { class: 'n' }, String(countOf(s))),
      ),
    );
  }
  bar.appendChild(el('span', { class: 'vdiv' }));
  bar.appendChild(el('span', { class: 'lbl' }, 'project'));
  const select = /** @type {HTMLSelectElement} */ (
    el(
      'select',
      {
        class: 'psel',
        'aria-label': 'project filter',
        onchange: (/** @type {Event} */ e) => {
          ui.projectFilter = /** @type {HTMLSelectElement} */ (e.target).value;
          renderFilters();
          renderMain();
        },
      },
      el('option', { value: '' }, 'all'),
      projects().map((p) => el('option', { value: p.name }, `${p.name} (P=${p.P})`)),
    )
  );
  select.value = ui.projectFilter;
  bar.appendChild(select);
  if (any || ui.projectFilter || ui.query) {
    bar.appendChild(
      el(
        'button',
        {
          class: 'clear',
          type: 'button',
          onclick: () => {
            ui.stateFilters.clear();
            ui.projectFilter = '';
            ui.query = '';
            /** @type {HTMLInputElement} */
            (byId('search')).value = '';
            renderFilters();
            renderMain();
          },
        },
        'clear',
      ),
    );
  }
  bar.appendChild(el('span', { class: 'spacer' }));
  const total = data?.ports.length ?? 0;
  const attention =
    typeof data?.summary?.attention === 'number'
      ? data.summary.attention
      : countOf('conflict') + countOf('squatter');
  const live =
    typeof data?.summary?.liveSessions === 'number'
      ? data.summary.liveSessions
      : (data?.sessions || []).filter((s) => s.alive).length;
  bar.appendChild(
    el(
      'span',
      { class: 'summary' },
      `${visiblePorts().length} of ${total} ports · ${attention} need attention · ${live} live sessions`,
    ),
  );
}

// ---------------------------------------------------------------------------
// shared cells

/** @param {State} s */
function stateChip(s) {
  return el('span', { class: `schip c-${s}` }, s);
}

/** Mark the drawer's port as selected in whatever rows/cells are on screen. */
function markSelected() {
  for (const node of document.querySelectorAll('[data-port]')) {
    node.classList.toggle(
      'sel',
      Number(/** @type {HTMLElement} */ (node).dataset.port) === ui.drawerPort,
    );
  }
}

/** @param {number} port */
function openDrawer(port) {
  if (!idx.byPort.has(port)) return;
  ui.drawerPort = port;
  ui.copied = false;
  renderDrawer();
  markSelected();
  if (ui.view === 'term') renderMain();
}

function closeDrawer() {
  ui.drawerPort = null;
  renderDrawer();
  markSelected();
  if (ui.view === 'term') renderMain();
}

// ---------------------------------------------------------------------------
// views

/** Re-render the main area for the current view, keeping scroll positions. */
function renderMain() {
  const main = byId('main');
  const scrolls = [...main.querySelectorAll('.scroll, .rail, .detail, .map, .rules, .term')].map(
    (n) => [n.className, n.scrollTop, n.scrollLeft],
  );
  clear(main);
  if (!data) {
    main.appendChild(
      el(
        'div',
        { class: 'empty' },
        ui.offline
          ? 'berth check is unreachable and no fixture could be loaded.'
          : 'Loading berth check…',
      ),
    );
    return;
  }
  const view = {
    sessions: renderSessions,
    table: renderTable,
    map: renderMap,
    rules: renderRules,
    term: renderTerm,
  }[ui.view];
  main.appendChild(view());
  for (const [cls, top, left] of scrolls) {
    const node = [...main.querySelectorAll('.scroll, .rail, .detail, .map, .rules, .term')].find(
      (n) => n.className === cls,
    );
    if (node) {
      node.scrollTop = Number(top);
      node.scrollLeft = Number(left);
    }
  }
  markSelected();
}

function renderSessions() {
  const report = /** @type {CheckReport} */ (data);
  const sel = selectedSession();
  const rail = el(
    'div',
    { class: 'rail', role: 'listbox', 'aria-label': 'sessions' },
    el('div', { class: 'rail-head' }, el('span', null, 'session'), el('span', null, 'leases')),
  );
  for (const s of report.sessions) {
    const recs = recordsOf(s);
    const worst = recs.length ? worstOf(recs, asState(s.worst)) : asState(s.worst || 'ok');
    const chips = STATES.filter((st) => st !== 'ok' && recs.some((r) => r.state === st)).map((st) =>
      el('span', { class: `mchip c-${st}` }, `${st} ${recs.filter((r) => r.state === st).length}`),
    );
    const where = s.project
      ? `${s.project} · W${s.worktree ?? 0}`
      : s.cwd
        ? tilde(s.cwd)
        : s.tool === 'human'
          ? 'VS Code / terminal'
          : s.tool === 'macos'
            ? 'root listeners'
            : '—';
    const alive = s.pid ? `pid ${s.pid}` : s.ended ? `ended ${fmtTime(s.ended)}` : '';
    rail.appendChild(
      el(
        'div',
        {
          class: `srow${sel && sel.id === s.id ? ' sel' : ''}`,
          role: 'option',
          'data-session': s.id,
          tabindex: 0,
          'aria-selected': String(!!sel && sel.id === s.id),
          onclick: () => {
            ui.selectedSession = s.id;
            renderMain();
          },
          onkeydown: keyActivate,
        },
        el('span', { class: `sq bg-${worst}` }),
        el(
          'div',
          { class: 'mid' },
          el(
            'div',
            { class: 'l1' },
            el('span', { class: 'id' }, s.tool === 'claude-code' ? s.short || shortId(s.id) : s.id),
            el('span', { class: 'tool' }, toolLabel(s.tool)),
          ),
          el('div', { class: 'where' }, where),
          el('div', { class: 'mini' }, chips),
        ),
        el('span', { class: 'right' }, String(recs.length), el('div', null, alive)),
      ),
    );
  }

  const detail = el('div', { class: 'detail' });
  if (sel) {
    const project = sel.project ? idx.projectByName.get(sel.project) : undefined;
    const W = sel.worktree ?? 0;
    const block = project ? `${project.base + 100 * W}–${project.base + 100 * W + 99}` : '—';
    const pidText = sel.pid
      ? `pid ${sel.pid} · started ${fmtTime(sel.started)}`
      : sel.ended
        ? `pid gone · started ${fmtTime(sel.started)}, ended ${fmtTime(sel.ended)}`
        : '—';
    const dot = el('span', { class: 'dim' }, ' · ');
    detail.appendChild(
      el(
        'div',
        { class: 'dhead' },
        el('div', null, el('div', { class: 'k' }, 'session'), el('div', { class: 'big' }, sel.id)),
        el(
          'div',
          null,
          el('div', { class: 'k' }, 'tool · pid'),
          el('div', null, toolLabel(sel.tool), dot, pidText),
        ),
        el(
          'div',
          null,
          el('div', { class: 'k' }, 'project · worktree · block'),
          el(
            'div',
            null,
            sel.project || '—',
            dot.cloneNode(true),
            `W${W}`,
            dot.cloneNode(true),
            block,
          ),
        ),
        el(
          'div',
          { class: 'full' },
          el('div', { class: 'k' }, 'cwd'),
          el(
            'div',
            { class: sel.cwdExists === false ? 'missing' : '' },
            sel.cwd ? tilde(sel.cwd) : '—',
            sel.cwdExists === false
              ? el('span', { class: 'dim' }, ' (missing — worktree removed)')
              : null,
          ),
        ),
        el(
          'div',
          { class: 'full' },
          el('div', { class: 'k' }, 'how we know'),
          el('div', { class: 'dim' }, (sel.howWeKnow || []).join(' · ') || '—'),
        ),
      ),
    );

    const rows = visiblePorts()
      .filter((r) => idx.sessionOfPort.get(r.port) === sel)
      .sort((a, b) => a.port - b.port);
    const table = el(
      'table',
      { class: 'lt' },
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          ['port', 'role', 'state', 'live holder', 'kind', 'age', 'url'].map((h) =>
            el('th', { scope: 'col' }, h),
          ),
        ),
      ),
      el(
        'tbody',
        null,
        rows.map((r) =>
          el(
            'tr',
            {
              class: r.state === 'idle' ? 'idle' : '',
              'data-port': r.port,
              tabindex: 0,
              onclick: () => openDrawer(r.port),
              onkeydown: keyActivate,
            },
            el('td', { class: 'port' }, String(r.port)),
            el('td', null, roleOf(r)),
            el('td', null, stateChip(r.state)),
            el('td', { class: 'nowrap' }, holderOf(r)),
            el('td', { class: 'dim' }, kindOf(r)),
            el('td', { class: 'dim' }, ageOf(r)),
            el('td', { class: 'url' }, urlLink(r.url)),
          ),
        ),
      ),
    );
    detail.appendChild(table);
    if (!rows.length)
      detail.appendChild(el('div', { class: 'empty' }, 'No leases match the current filters.'));
  } else {
    detail.appendChild(el('div', { class: 'empty' }, 'No sessions reported.'));
  }
  return el('div', { class: 'sess' }, rail, detail);
}

function renderTable() {
  const groups = groupByProject(visiblePorts());
  const tbody = el('tbody');
  for (const g of groups) {
    tbody.appendChild(
      el(
        'tr',
        { class: 'grp' },
        el(
          'td',
          { colspan: 9 },
          el('span', { class: 'gname' }, g.name),
          g.project
            ? el('span', { class: 'gmeta' }, `P=${g.project.P} · ${blockRange(g.project)}`)
            : el('span', { class: 'gmeta' }, 'no project · outside every block'),
          g.project ? el('span', { class: 'gpath' }, g.project.path) : null,
        ),
      ),
    );
    for (const r of g.rows) {
      const W = worktreeOf(r);
      const s = sessionOf(r);
      const wname = W
        ? (r.lease?.cwd || s?.cwd || '').split('/').filter(Boolean).pop() || ''
        : 'main';
      tbody.appendChild(
        el(
          'tr',
          {
            class: `row${r.state === 'idle' ? ' idle' : ''}`,
            'data-port': r.port,
            tabindex: 0,
            onclick: () => openDrawer(r.port),
            onkeydown: keyActivate,
          },
          el('td', { class: 'w' }, `W${W} `, el('span', { class: 'wn' }, wname)),
          el('td', { class: 'port' }, String(r.port)),
          el('td', null, roleOf(r)),
          el('td', null, stateChip(r.state)),
          el('td', { class: 'nowrap' }, holderOf(r)),
          el('td', { class: 'dim' }, sessionLabel(r)),
          el('td', { class: 'cwd', title: cwdOf(r) }, cwdOf(r) || '—'),
          el('td', { class: 'dim' }, ageOf(r)),
          el('td', { class: 'url' }, urlLink(r.url)),
        ),
      );
    }
  }
  const table = el(
    'table',
    { class: 'pt' },
    el(
      'thead',
      null,
      el(
        'tr',
        null,
        [
          'project / worktree',
          'port',
          'role',
          'state',
          'live holder',
          'session',
          'cwd',
          'age',
          'url',
        ].map((h) => el('th', { scope: 'col' }, h)),
      ),
    ),
    tbody,
  );
  const wrap = el('div', { class: 'scroll' }, table);
  if (!groups.length)
    wrap.appendChild(el('div', { class: 'empty' }, 'No leases match the current filters.'));
  return wrap;
}

/**
 * One range-map cell (block, extra or legacy) or legacy-strip tick with hover tooltip and
 * click-to-drawer. A legacy cell is 34px wide and shows its port number: it sits outside the
 * block scheme, so there is no P/W/R position to read the port from.
 * @param {PortRecord|undefined} r
 * @param {number} port
 * @param {Project|undefined} project
 * @param {{extra?: boolean, tick?: boolean, legacy?: boolean, role?: string}} [opts]
 */
function cell(r, port, project, opts = {}) {
  const state = r ? r.state : null;
  const W = r ? worktreeOf(r) : (decodeClient(port)?.W ?? 0);
  let role = opts.role || (r ? roleOf(r) : roleForPort(port, project));
  if (r && !r.decoded && role === '—') role = kindOf(r);
  const where = r && !r.decoded ? 'legacy' : `W${W}`;
  const cls = opts.tick
    ? `tick${state ? ` s-${state}` : ''}`
    : `cell${opts.extra ? ' x' : ''}${opts.legacy ? ' lg' : ''}${state ? ` has s-${state}` : ''}`;
  const off = r && !matches(r);
  const owner = r ? ownerLabel(r) : '';
  const node = el(
    r ? 'button' : 'div',
    {
      class: `${cls}${off ? ' off' : ''}`,
      type: r ? 'button' : null,
      'data-port': r ? port : null,
      'aria-label': r ? `port ${port} ${state}` : null,
      onclick: r ? () => openDrawer(port) : null,
      onmouseenter: (/** @type {MouseEvent} */ e) =>
        showTip(e, {
          port,
          state: state || 'free',
          line1: `${project ? project.name : 'unassigned'} · ${where} · ${role || '—'}`,
          line2: r ? `${holderOf(r)}${owner ? ` · ${owner}` : ''}` : 'no lease, nothing bound',
        }),
      onmousemove: moveTip,
      onmouseleave: hideTip,
      onfocus: null,
    },
    opts.legacy ? String(port) : null,
  );
  return node;
}

/** `session xxxxxxxx` or the owning tool, for tooltips. @param {PortRecord} r */
function ownerLabel(r) {
  const s = sessionOf(r);
  if (s)
    return s.tool === 'claude-code' ? `session ${s.short || shortId(s.id)}` : toolLabel(s.tool);
  const owner = r.lease?.owner;
  if (owner)
    return owner.session_id ? `session ${shortId(owner.session_id)}` : toolLabel(owner.tool);
  if (r.live?.sessionId) return `session ${shortId(r.live.sessionId)}`;
  return '';
}

function renderMap() {
  const report = /** @type {CheckReport} */ (data);
  const pmax = idx.projectMax;
  const wrap = el('div', { class: 'map', onmouseleave: hideTip });
  wrap.appendChild(
    el(
      'div',
      { class: 'legend' },
      el(
        'span',
        null,
        `block range ${idx.base}–${idx.blockEnd - 1} · one row per P · cells = roles 00–09 per worktree`,
      ),
      el('span', { class: 'spacer' }),
      STATES.map((s) =>
        el(
          'span',
          { class: 'li' },
          el('span', { class: `sw ${HATCHED.has(s) ? 'h-' : 'bg-'}${s}` }),
          s,
        ),
      ),
      el('span', { class: 'li' }, el('span', { class: 'sw bg-free' }), 'free'),
      el('span', { class: 'li' }, el('span', { class: 'sw lg' }, '5432'), 'legacy'),
    ),
  );

  const grid = el('div', { class: 'grid' });
  for (let P = 0; P <= pmax; P++) {
    const project = idx.projectByP.get(P);
    const base = baseOfP(P, project);
    // Every record attributed to this project: block cells by P/W/R plus a legacy group for the
    // undecoded ports (declared, shared — which belong to their owner — and anything else the
    // server attributed here). A comma-joined `project` counts for each name in it.
    const recs = project ? report.ports.filter((r) => projectsOf(r).includes(project.name)) : [];
    const legacy = recs.filter((r) => !r.decoded).sort((a, b) => a.port - b.port);
    const Ws = [
      0,
      ...new Set(
        recs
          .filter((r) => r.decoded)
          .map(worktreeOf)
          .filter((w) => w > 0),
      ),
    ].sort((a, b) => a - b);
    // Lit when anything is actually bound on the row, block or legacy; a project holding only
    // leases, declarations or shared entries with no live holder is dimmed.
    const live = recs.some((r) => r.live);
    const opacity = !project ? 'o35' : live ? '' : 'o60';
    grid.appendChild(el('div', { class: `p ${opacity}` }, String(P).padStart(2, '0')));
    grid.appendChild(
      el(
        'div',
        { class: `nm ${opacity}${project ? '' : ' un'}` },
        project ? project.name : '—',
        project ? el('span', { class: 'base' }, String(base)) : null,
      ),
    );
    const cells = el('div', { class: `cells ${opacity}` });
    for (const W of Ws) {
      const group = el('div', { class: 'wg' }, el('span', { class: 'wl' }, `W${W}`));
      for (let R = 0; R < 10; R++) {
        const port = base + 100 * W + R;
        group.appendChild(cell(idx.byPort.get(port), port, project));
      }
      const extras = Object.entries(project?.extras || {}).sort((a, b) => a[1] - b[1]);
      if (extras.length) {
        group.appendChild(el('span', { class: 'xl' }, `+${extras.length} extras`));
        for (const [name, slot] of extras) {
          const port = base + 100 * W + slot;
          group.appendChild(cell(idx.byPort.get(port), port, project, { extra: true, role: name }));
        }
      }
      cells.appendChild(group);
    }
    if (legacy.length) {
      const group = el('div', { class: 'wg' }, el('span', { class: 'wl lg' }, 'legacy'));
      for (const r of legacy) group.appendChild(cell(r, r.port, project, { legacy: true }));
      cells.appendChild(group);
    }
    grid.appendChild(cells);
  }
  wrap.appendChild(grid);

  // legacy strip 1024–9999
  const pct = (/** @type {number} */ p) =>
    (((p - LEGACY_MIN) / (LEGACY_MAX - LEGACY_MIN)) * 100).toFixed(2) + '%';
  wrap.appendChild(
    el(
      'div',
      { class: 'lbl strip-lbl' },
      `legacy strip ${LEGACY_MIN}–${LEGACY_MAX} · declared ports and live listeners outside the block scheme`,
    ),
  );
  const strip = el('div', { class: 'strip' });
  for (const [lo, hi] of report.policy.reserved.ranges || []) {
    const a = Math.max(lo, LEGACY_MIN),
      b = Math.min(hi, LEGACY_MAX);
    if (a > b) continue;
    strip.appendChild(
      el('div', {
        class: 'band',
        title: `${lo}–${hi} ${RESERVED_LABEL[lo] || 'reserved'}`,
        style: {
          left: pct(a),
          width: (((b - a + 1) / (LEGACY_MAX - LEGACY_MIN)) * 100).toFixed(2) + '%',
        },
      }),
    );
  }
  const seen = new Set();
  for (const r of report.ports
    .filter((p) => p.port >= LEGACY_MIN && p.port <= LEGACY_MAX)
    .sort((a, b) => a.port - b.port)) {
    seen.add(r.port);
    const t = cell(r, r.port, idx.projectByName.get(projectOf(r)), { tick: true, role: roleOf(r) });
    t.style.left = pct(r.port);
    strip.appendChild(t);
  }
  /** @type {Map<number, string[]>} */
  const declared = new Map();
  for (const p of report.policy.projects)
    for (const d of p.declared || [])
      if (!seen.has(d) && d >= LEGACY_MIN && d <= LEGACY_MAX)
        declared.set(d, [...(declared.get(d) || []), p.name]);
  for (const [name, shared] of Object.entries(report.policy.shared || {}))
    for (const port of Object.values(shared.ports || {}))
      if (!seen.has(port) && port >= LEGACY_MIN && port <= LEGACY_MAX && !declared.has(port))
        declared.set(port, [`shared.${name} (${shared.owner})`]);
  for (const [port, names] of [...declared].sort((a, b) => a[0] - b[0])) {
    strip.appendChild(
      el('div', {
        class: 'tick decl',
        style: { left: pct(port) },
        onmouseenter: (/** @type {MouseEvent} */ e) =>
          showTip(e, {
            port,
            state: 'declared',
            line1: `declared by ${names.join(', ')}`,
            line2: 'nothing bound',
          }),
        onmousemove: moveTip,
        onmouseleave: hideTip,
      }),
    );
  }
  for (const p of LANDMARKS)
    strip.appendChild(el('span', { class: 'landmark', style: { left: pct(p) } }, String(p)));
  wrap.appendChild(strip);
  const reservedPorts = (report.policy.reserved.ports || []).join('/');
  wrap.appendChild(
    el(
      'div',
      { class: 'strip-cap' },
      el(
        'span',
        null,
        `tall tick = live listener · short tick = declared only · hatched = reserved (portless 4000–4999${reservedPorts ? `, AirPlay ${reservedPorts}` : ''})`,
      ),
    ),
  );
  return wrap;
}

function renderRules() {
  const report = /** @type {CheckReport} */ (data);
  const { scheme, pools, reserved, shared } = report.policy;
  const pmax = idx.projectMax;
  const roles = Object.entries(scheme.roles || {}).sort((a, b) => a[1] - b[1]);
  const schemePanel = el(
    'section',
    { class: 'panel' },
    el('div', { class: 'ph' }, 'scheme · ~/.config/berth/policy.toml'),
    el(
      'div',
      { class: 'formula' },
      `port = ${idx.base} + 1000·`,
      el('span', { class: 'c-ok' }, 'P'),
      ' + 100·',
      el('span', { class: 'c-drift' }, 'W'),
      ' + ',
      el('span', { class: 'c-stale' }, 'R'),
    ),
    el(
      'div',
      { class: 'explain' },
      el('span', { class: 'c-ok' }, 'P'),
      el(
        'span',
        null,
        `project, hand-assigned, permanent, 0–${pmax} → blocks ${idx.base}–${idx.blockEnd - 1}`,
      ),
      el('span', { class: 'c-drift' }, 'W'),
      el('span', null, `worktree, 0 = main checkout, 1–${idx.worktreeMax} additional`),
      el('span', { class: 'c-stale' }, 'R'),
      el('span', null, 'role slot, 00–09 canonical, 10–99 project-named extras'),
    ),
    el(
      'div',
      { class: 'roles' },
      roles.map(([name, R]) =>
        el(
          'div',
          { class: 'role' },
          el('div', { class: 'code' }, String(R).padStart(2, '0')),
          el('div', null, name),
        ),
      ),
    ),
  );

  const rangeText =
    (reserved.ranges || [])
      .map(([lo, hi]) => `${lo}–${hi}${RESERVED_LABEL[lo] ? ` ${RESERVED_LABEL[lo]}` : ''}`)
      .join(' · ') || '—';
  const lintText =
    (reserved.lint || []).map((p) => `${p}${LINT_NAME[p] ? ` ${LINT_NAME[p]}` : ''}`).join(' · ') ||
    '—';
  const poolsPanel = el(
    'section',
    { class: 'panel' },
    el('div', { class: 'ph' }, 'pools and reserved'),
    el(
      'div',
      { class: 'kv' },
      el('span', { class: 'fk' }, 'dynamic'),
      el(
        'span',
        null,
        `${pools.dynamic[0]}–${pools.dynamic[1]} · TTL ${pools.ttlHours} h · kept below 48000`,
      ),
      el('span', { class: 'fk' }, 'reserved'),
      el('span', null, rangeText),
      el('span', { class: 'fk' }, 'ports'),
      el(
        'span',
        null,
        `${(reserved.ports || []).join(', ') || '—'} · macOS AirPlay (ControlCenter)`,
      ),
      el('span', { class: 'fk' }, 'lint'),
      el('span', null, lintText),
    ),
  );
  for (const [name, s] of Object.entries(shared || {})) {
    poolsPanel.appendChild(el('div', { class: 'ph mid' }, `shared.${name} · owner ${s.owner}`));
    poolsPanel.appendChild(
      el(
        'div',
        { class: 'shared' },
        Object.entries(s.ports || {})
          .sort((a, b) => a[1] - b[1])
          .map(([role, port]) =>
            el(
              'button',
              {
                class: 'pbtn',
                type: 'button',
                onclick: () => openDrawer(port),
                disabled: !idx.byPort.has(port) || null,
                title: idx.byPort.has(port) ? `berth who ${port}` : `${port} is not bound`,
              },
              el('span', { class: 'port' }, String(port)),
              el('span', { class: 'nm' }, role),
            ),
          ),
      ),
    );
    if (s.note) poolsPanel.appendChild(el('div', { class: 'note' }, s.note));
  }

  const projectsPanel = el(
    'section',
    { class: 'panel full' },
    el(
      'div',
      { class: 'ph' },
      'projects · P is permanent · declared ports register as-is and participate in collision checks',
    ),
    el(
      'table',
      { class: 'rt' },
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          ['P', 'project', 'block', 'path', 'declared', 'extras'].map((h) =>
            el('th', { scope: 'col' }, h),
          ),
        ),
      ),
      el(
        'tbody',
        null,
        projects().map((p) =>
          el(
            'tr',
            null,
            el('td', { class: 'c-ok' }, String(p.P)),
            el('td', { class: 'port' }, p.name),
            el('td', null, blockRange(p)),
            el('td', { class: 'dim' }, p.path),
            el('td', { class: 'dim' }, (p.declared || []).join(', ') || '—'),
            el(
              'td',
              { class: 'dim' },
              Object.entries(p.extras || {})
                .map(([k, v]) => `${k}=${v}`)
                .join(' ') || '—',
            ),
          ),
        ),
      ),
    ),
  );
  return el('div', { class: 'rules' }, schemePanel, poolsPanel, projectsPanel);
}

/** @param {string|number} s @param {number} n */
function pad(s, n) {
  return String(s).padEnd(n);
}

function renderTerm() {
  const report = /** @type {CheckReport} */ (data);
  const pre = el('pre');
  const prompt = (/** @type {string} */ cmd) => [
    el('span', { class: 'pr' }, '$ '),
    el('span', { class: 'cmd' }, cmd),
    '\n',
  ];
  /** @param {State} s @param {number} width */
  const stateWord = (s, width) => [
    el('span', { class: `c-${s}` }, s),
    pad('', Math.max(0, width - s.length)),
  ];

  appendChildren(pre, prompt('berth ls'));
  for (const g of groupByProject(visiblePorts())) {
    appendChildren(pre, [
      `\n${g.name}  ${g.project ? `P=${g.project.P}  ${blockRange(g.project)}` : 'outside every block'}\n`,
    ]);
    for (const r of g.rows) {
      appendChildren(pre, [
        `  W${worktreeOf(r)}  ${pad(r.port, 6)}${pad(roleOf(r), 11)}`,
        stateWord(r.state, 10),
        `${pad(holderOf(r), 38)}${holderOf(r).length >= 38 ? ' ' : ''}${sessionLabel(r)}\n`,
      ]);
    }
  }
  appendChildren(pre, ['\n']);

  const who = idx.byPort.get(ui.drawerPort ?? 17101) || report.ports[0];
  if (who) {
    const dec = decode(who.port, who);
    appendChildren(pre, prompt(`berth who ${who.port}`));
    appendChildren(pre, [
      `\n  ${pad('port', 9)}${who.port}  (${dec.text})\n`,
      `  ${pad('lease', 9)}${who.lease ? `${who.lease.kind} · ${who.lease.project} · W${who.lease.worktree} · ${who.lease.role}` : 'none'}\n`,
      `  ${pad('owner', 9)}${who.lease ? (ownerLabel(who) ? `${ownerLabel(who)}${who.lease.owner.session_id ? '…' : ''}` : 'none') : 'none'}\n`,
      `  ${pad('holder', 9)}${holderOf(who)}\n`,
      `  ${pad('state', 9)}`,
      el('span', { class: `c-${who.state}` }, who.state),
      '\n',
      (who.evidence || []).map((line) => `  ${pad('because', 9)}${line}\n`),
      '\n',
    ]);
  }

  appendChildren(pre, prompt('berth check'));
  appendChildren(pre, ['\n']);
  for (const s of STATES) appendChildren(pre, ['  ', stateWord(s, 10), `${countOf(s)}\n`]);
  const live =
    typeof report.summary?.liveSessions === 'number'
      ? report.summary.liveSessions
      : report.sessions.filter((s) => s.alive).length;
  appendChildren(pre, [
    `  ${report.ports.length} ports · ${live} live sessions · reconcile cached ${report.cacheAgeMs ?? 0} ms ago · exit 0\n`,
  ]);

  return el(
    'div',
    { class: 'term' },
    el(
      'div',
      { class: 'intro' },
      'Terminal equivalent of the current view. Same data, same states; ',
      el('span', { class: 'c-fg' }, '--json'),
      ' is the boundary the dashboard polls.',
    ),
    pre,
  );
}

// ---------------------------------------------------------------------------
// drawer (berth who)

function renderDrawer() {
  const aside = byId('drawer');
  clear(aside);
  const r = ui.drawerPort != null ? idx.byPort.get(ui.drawerPort) : undefined;
  if (!r || !data) {
    aside.hidden = true;
    return;
  }
  aside.hidden = false;
  aside.setAttribute('aria-label', `port ${r.port}`);
  const dec = decode(r.port, r);
  const s = sessionOf(r);
  const owner = r.lease?.owner;
  let ownerText = 'none';
  if (owner) {
    if (owner.session_id) {
      const alive = s ? s.alive : true;
      const pid = alive ? (owner.pid ?? s?.pid) : undefined;
      ownerText = `session ${shortId(owner.session_id)}… (pid ${pid ?? 'gone'})`;
    } else ownerText = `${toolLabel(owner.tool)}${owner.pid ? ` (pid ${owner.pid})` : ''}`;
  }
  const ttl = idx.ttlHours;
  const expires = r.lease?.expires
    ? `${fmtTime(r.lease.expires)} (${ttl}h TTL)`
    : r.lease
      ? r.lease.kind === 'dynamic'
        ? `${ttl} h`
        : 'none (liveness beats wall-clock)'
      : '—';
  const age = ageOf(r);
  const created = /\d/.test(age) ? `${age} ago` : r.lease ? fmtTime(r.lease.created) : '—';
  const advisory = r.advisory || ADVICE[r.state] || ADVICE.ok;
  const cmd = advisory.command ? advisory.command.replace('{p}', String(r.port)) : '';
  const disagree = r.state === 'conflict' || r.state === 'squatter';

  aside.appendChild(
    el(
      'div',
      { class: 'dr-head' },
      el('span', { class: 'dr-port' }, String(r.port)),
      el('span', { class: `dr-chip c-${r.state}` }, r.state),
      el('span', { class: 'spacer' }),
      el(
        'button',
        { class: 'dr-close', type: 'button', 'aria-label': 'close', onclick: closeDrawer },
        '×',
      ),
    ),
  );

  aside.appendChild(
    el(
      'div',
      { class: 'sec' },
      el('div', { class: 'k' }, 'decoded'),
      el(
        'div',
        { class: 'decode' },
        el('span', { class: 'plus' }, `${idx.base} +`),
        el('span', { class: 'P' }, `1000·${dec.P}`),
        el('span', { class: 'plus' }, ' +'),
        el('span', { class: 'W' }, `100·${dec.W}`),
        el('span', { class: 'plus' }, ' +'),
        el(
          'span',
          { class: 'R' },
          typeof dec.R === 'number' ? String(dec.R).padStart(2, '0') : dec.R,
        ),
      ),
      el('div', { class: 'decode-txt' }, dec.text),
    ),
  );

  aside.appendChild(
    el(
      'div',
      { class: 'sec facts' },
      el('span', { class: 'fk' }, 'lease'),
      el(
        'span',
        null,
        r.lease
          ? `${r.lease.kind} · ${r.lease.project} · W${r.lease.worktree} · ${r.lease.role}`
          : 'none',
      ),
      el('span', { class: 'fk' }, 'owner'),
      el('span', null, ownerText),
      el('span', { class: 'fk' }, 'live holder'),
      el('span', { class: disagree ? `c-${r.state}` : '' }, holderOf(r)),
      el('span', { class: 'fk' }, 'cwd'),
      el('span', { class: 'brk' }, cwdOf(r) || '—'),
      el('span', { class: 'fk' }, 'created'),
      el('span', null, created),
      el('span', { class: 'fk' }, 'expires'),
      el('span', null, expires),
      el('span', { class: 'fk' }, 'url'),
      el('span', null, urlLink(r.url, '—')),
    ),
  );

  aside.appendChild(
    el(
      'div',
      { class: 'sec' },
      el('div', { class: 'k' }, 'how we know'),
      (r.evidence || []).map((line) =>
        el(
          'div',
          { class: 'ev' },
          el('span', { class: 'm' }, '›'),
          el('span', { class: 't' }, line),
        ),
      ),
      !(r.evidence || []).length
        ? el(
            'div',
            { class: 'ev' },
            el('span', { class: 'm' }, '›'),
            el('span', { class: 't' }, 'no evidence recorded'),
          )
        : null,
    ),
  );

  const advisorySec = el(
    'div',
    { class: 'sec' },
    el('div', { class: 'k' }, 'advisory'),
    el('div', { class: `advice c-${r.state}` }, advisory.text),
  );
  if (cmd) {
    const copyBtn = el(
      'button',
      { class: 'copy', type: 'button', onclick: () => copyCommand(cmd, copyBtn) },
      ui.copied ? 'copied' : 'copy',
    );
    advisorySec.appendChild(el('div', { class: 'cmdbox' }, el('code', null, cmd), copyBtn));
    advisorySec.appendChild(
      el('div', { class: 'foot' }, 'berth never kills or reassigns. Exit code is always 0.'),
    );
  }
  aside.appendChild(advisorySec);

  aside.appendChild(
    el(
      'div',
      { class: 'sec' },
      el('div', { class: 'k' }, `who ${r.port} · json`),
      el('pre', { class: 'json' }, JSON.stringify(r, null, 1)),
    ),
  );
}

/**
 * @param {string} cmd
 * @param {HTMLElement} button
 */
function copyCommand(cmd, button) {
  const done = () => {
    ui.copied = true;
    button.textContent = 'copied';
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      ui.copied = false;
      if (button.isConnected) button.textContent = 'copy';
    }, 1500);
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(cmd).then(done, done);
  else done();
}

// ---------------------------------------------------------------------------
// tooltip

/**
 * @param {MouseEvent} e
 * @param {{port: number, state: string, line1: string, line2: string}} t
 */
function showTip(e, t) {
  const tip = byId('tip');
  clear(tip);
  const st = STATES.includes(/** @type {State} */ (t.state)) ? `c-${t.state}` : 'c-dim';
  tip.appendChild(
    el(
      'div',
      { class: 'l0' },
      el('span', { class: 'port' }, String(t.port)),
      el('span', { class: `st ${st}` }, t.state),
    ),
  );
  tip.appendChild(el('div', { class: 'l1' }, t.line1));
  tip.appendChild(el('div', { class: 'l2' }, t.line2));
  tip.hidden = false;
  moveTip(e);
}

/** @param {MouseEvent} e */
function moveTip(e) {
  const tip = byId('tip');
  if (tip.hidden) return;
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 4);
  const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 4);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTip() {
  byId('tip').hidden = true;
}

// ---------------------------------------------------------------------------
// theme

/** @returns {'dark'|'light'} */
function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** @param {'dark'|'light'} theme */
function applyTheme(theme) {
  ui.theme = theme;
  document.body.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode or storage disabled: theme is session-only */
  }
  renderHeaderStatus();
}

// ---------------------------------------------------------------------------
// boot

/** Full re-render. Hides the tooltip (its cell is about to be replaced) and keeps keyboard focus. */
function render() {
  const focus = focusKey();
  hideTip();
  renderHeaderStatus();
  renderTabs();
  renderFilters();
  renderMain();
  renderDrawer();
  restoreFocus(focus);
}

function boot() {
  applyTheme(loadTheme());
  byId('bound').textContent = `ui :${location.port || '10000'}`;
  const search = /** @type {HTMLInputElement} */ (byId('search'));
  search.addEventListener('input', () => {
    ui.query = search.value;
    renderFilters();
    renderMain();
  });
  byId('pollBtn').addEventListener('click', () => {
    ui.polling = !ui.polling;
    renderHeaderStatus();
    if (ui.polling) void load();
  });
  byId('refreshBtn').addEventListener('click', () => {
    void load();
  });
  byId('themeBtn').addEventListener('click', () =>
    applyTheme(ui.theme === 'dark' ? 'light' : 'dark'),
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ui.drawerPort != null) closeDrawer();
      hideTip();
    }
  });
  window.addEventListener('scroll', hideTip, true);
  render();
  void load();
  setInterval(tick, 1000);
}

boot();

/**
 * The e-ink page (`/?kindle`, served as `kindle.html`): a minimal tmuxy for a
 * browser too old or too slow for the app — the Kindle Scribe's Silk, which
 * is Chrome 80. Built on its own for that engine (`vite.kindle.config.ts`).
 *
 * It holds no model of its own. The event stream keeps the session's monitor
 * alive and says when something changed; each change is answered by asking
 * for the whole state (`get_initial_state`) and drawing it again, at most
 * once per `REDRAW_MS`, since e-ink pays for every repaint. The page sizes the
 * session to its screen as any client does, through the connection id the
 * stream greets it with, and hands that size back when it disconnects.
 */
import { toClientState } from '../domain/client';
import { TmuxOp, toTmuxCommand } from '../domain/commands';
import type { PaneId } from '../domain/ids';
import { ConnectionInfo, MessageFrame } from '../domain/wire';
import { buildEndpointUrl, getSessionFromUrl } from '../infra/transport/endpoint';
import { decodeEvent, decodeStateForListener } from '../infra/transport/wireDecode';
import { kindleView, type KindleView, type Run } from './grid';
import './kindle.css';

/** The least time between two redraws: an e-ink refresh is slow and flashes. */
const REDRAW_MS = 700;
/** How long to wait before reopening a stream the server closed. */
const RETRY_MS = 3000;
const FONT_KEY = 'tmuxy-kindle-font';
const FONT_MIN = 10;
const FONT_MAX = 32;

/** The key row, left to right: label and tmux key name. */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Esc', 'Escape'],
  ['Tab', 'Tab'],
  ['^C', 'C-c'],
  ['^D', 'C-d'],
  ['⌫', 'BSpace'],
  ['←', 'Left'],
  ['↓', 'Down'],
  ['↑', 'Up'],
  ['→', 'Right'],
  ['PgUp', 'PPage'],
  ['PgDn', 'NPage'],
  ['⏎', 'Enter'],
];

const decodeConnectionInfo = decodeEvent(ConnectionInfo, 'connection-info');
const decodeTmuxError = decodeEvent(MessageFrame, 'tmux-error');

const session = getSessionFromUrl();
let connectionId: number | null = null;
let view: KindleView | null = null;
/** Each drawn row's markup, to repaint only the rows that changed. */
const rowHtml: string[] = [];
let fetching = false;
let pending = false;
let lastDraw = 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const tabsBar = el('nav', 'kindle-tabs');
const fontDown = el('button', 'kindle-font', 'A−');
const fontUp = el('button', 'kindle-font', 'A+');
const header = el('header', 'kindle-header');
header.append(tabsBar, fontDown, fontUp);

const screen = el('div', 'kindle-screen');
const status = el('div', 'kindle-status', 'Connecting…');
const probe = el('span', 'kindle-probe', 'MMMMMMMMMM');

const keys = el('div', 'kindle-keys');
for (const [label, key] of KEYS) {
  const button = el('button', 'kindle-key', label);
  button.dataset.key = key;
  keys.append(button);
}

const form = el('form', 'kindle-input');
const input = el('input', 'kindle-text');
input.type = 'text';
input.autocapitalize = 'off';
input.autocomplete = 'off';
input.spellcheck = false;
input.placeholder = 'Type, then Send (Enter included)';
const send = el('button', 'kindle-send', 'Send');
send.type = 'submit';
form.append(input, send);

const footer = el('footer', 'kindle-footer');
footer.append(keys, form, status);
document.body.append(header, screen, probe, footer);

function setStatus(text: string): void {
  status.textContent = text;
  status.hidden = text === '';
}

async function command(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (connectionId !== null) headers['X-Connection-Id'] = String(connectionId);
  const response = await fetch(buildEndpointUrl('/commands', session), {
    method: 'POST',
    headers,
    body: JSON.stringify({ cmd, args }),
  });
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (body.error !== undefined) throw new Error(body.error);
  return body.result;
}

/**
 * Commands go out one at a time, each after the last was answered: two
 * requests in flight can reach the server in either order, and text sent
 * before its Enter must arrive before it.
 */
let sent: Promise<unknown> = Promise.resolve();
function run(op: TmuxOp): void {
  const tmuxCommand = toTmuxCommand(op);
  sent = sent
    .then(() => command('run_tmux_command', { command: tmuxCommand }))
    .catch((e: unknown) => setStatus(String(e)));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function runHtml(run: Run): string {
  const classes = [
    run.bold ? 'b' : '',
    run.underline ? 'u' : '',
    run.inverse ? 'i' : '',
    run.dim ? 'd' : '',
  ].filter(Boolean);
  const text = escapeHtml(run.text);
  return classes.length === 0 ? text : `<span class="${classes.join(' ')}">${text}</span>`;
}

function drawTabs(next: KindleView): void {
  tabsBar.textContent = '';
  for (const tab of next.tabs) {
    const button = el('button', tab.active ? 'kindle-tab active' : 'kindle-tab', tab.label);
    button.dataset.window = tab.id;
    tabsBar.append(button);
  }
}

function draw(next: KindleView): void {
  const tabsChanged =
    view === null ||
    view.tabs.length !== next.tabs.length ||
    view.tabs.some(
      (t, i) =>
        t.id !== next.tabs[i].id ||
        t.label !== next.tabs[i].label ||
        t.active !== next.tabs[i].active,
    );
  view = next;
  if (tabsChanged) drawTabs(next);
  // Repaint only the rows that changed: every write is an e-ink refresh.
  next.rows.forEach((row, i) => {
    const html = row.map(runHtml).join('');
    if (rowHtml[i] === html) return;
    const line =
      (screen.children[i] as HTMLElement | undefined) ?? screen.appendChild(el('div', 'row'));
    line.innerHTML = html;
    rowHtml[i] = html;
  });
  while (screen.children.length > next.rows.length) screen.lastElementChild?.remove();
  rowHtml.length = next.rows.length;
}

/** Fetch the whole state and draw it; coalesces requests that arrive meanwhile. */
async function refresh(): Promise<void> {
  if (fetching) {
    pending = true;
    return;
  }
  fetching = true;
  try {
    const state = decodeStateForListener(await command('get_initial_state'));
    if (state) draw(kindleView(toClientState(state)));
    setStatus('');
  } catch (e) {
    setStatus(String(e));
  } finally {
    fetching = false;
    lastDraw = Date.now();
    if (pending) {
      pending = false;
      scheduleRefresh();
    }
  }
}

let refreshTimer: number | undefined;
function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return;
  const wait = Math.max(0, lastDraw + REDRAW_MS - Date.now());
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, wait);
}

/** The cells the screen holds at the current font size. */
function measure(): { cols: number; rows: number } {
  const box = probe.getBoundingClientRect();
  const cellWidth = box.width / 10;
  const cellHeight = box.height;
  const area = screen.getBoundingClientRect();
  return {
    cols: Math.max(20, Math.floor(area.width / cellWidth)),
    rows: Math.max(5, Math.floor(area.height / cellHeight)),
  };
}

async function sendSize(): Promise<void> {
  if (connectionId === null) return;
  const { cols, rows } = measure();
  await command('set_client_size', { cols, rows }).catch(() => undefined);
  scheduleRefresh();
}

function setFont(px: number): void {
  const size = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
  document.documentElement.style.setProperty('--kindle-font', `${size}px`);
  localStorage.setItem(FONT_KEY, String(size));
}

function fontSize(): number {
  return Number(localStorage.getItem(FONT_KEY)) || 16;
}

let source: EventSource | null = null;
async function connect(): Promise<void> {
  source?.close();
  connectionId = null;
  setStatus('Connecting…');
  try {
    await command('ensure_session');
  } catch (e) {
    setStatus(String(e));
    window.setTimeout(() => void connect(), RETRY_MS);
    return;
  }
  const events = new EventSource(buildEndpointUrl('/events', session));
  source = events;
  events.addEventListener('connection-info', (event) => {
    const info = decodeConnectionInfo(JSON.parse((event as MessageEvent).data).data);
    if (!info) return;
    connectionId = info.connection_id;
    void sendSize();
  });
  events.addEventListener('state-update', scheduleRefresh);
  events.addEventListener('tmux-error', (event) => {
    const frame = decodeTmuxError(JSON.parse((event as MessageEvent).data).data);
    if (frame) setStatus(frame.message);
  });
  events.onerror = () => {
    setStatus('Reconnecting…');
    // A closed stream is not retried by the browser: the session may be gone.
    if (events.readyState === EventSource.CLOSED) {
      window.setTimeout(() => void connect(), RETRY_MS);
    }
  };
}

function target(): PaneId | null {
  return view?.target ?? null;
}

keys.addEventListener('click', (event) => {
  const key = (event.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
  const pane = target();
  if (key && pane) run(TmuxOp.SendKeys({ target: pane, keys: key }));
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const pane = target();
  if (!pane) return;
  if (input.value !== '') run(TmuxOp.SendText({ target: pane, text: input.value }));
  run(TmuxOp.SendKeys({ target: pane, keys: 'Enter' }));
  input.value = '';
});

tabsBar.addEventListener('click', (event) => {
  const id = (event.target as HTMLElement).closest<HTMLElement>('[data-window]')?.dataset.window;
  const tab = view?.tabs.find((t) => t.id === id);
  if (tab && !tab.active) run(TmuxOp.SelectWindow({ target: tab.id }));
});

/** A tap on a pane that is not the keyboard's makes it the keyboard's. */
screen.addEventListener('click', (event) => {
  if (!view) return;
  const box = probe.getBoundingClientRect();
  const area = screen.getBoundingClientRect();
  const col = Math.floor((event.clientX - area.left + screen.scrollLeft) / (box.width / 10));
  const row = Math.floor((event.clientY - area.top + screen.scrollTop) / box.height);
  const pane = view.panes.find(
    (p) => col >= p.x && col < p.x + p.width && row >= p.y && row < p.y + p.height,
  );
  if (!pane || pane.id === view.target) return;
  run(TmuxOp.SelectPane({ paneId: pane.id }));
  // Keys typed before the next state arrives belong to the tapped pane.
  view = { ...view, target: pane.id };
});

fontDown.addEventListener('click', () => {
  setFont(fontSize() - 2);
  void sendSize();
});
fontUp.addEventListener('click', () => {
  setFont(fontSize() + 2);
  void sendSize();
});

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => void sendSize(), 300);
});

setFont(fontSize());
void connect();

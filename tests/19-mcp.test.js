/**
 * An MCP client driving the session through `POST /mcp`.
 *
 * The agent's side is HTTP, exactly as an MCP client sends it: JSON-RPC to
 * the server, no browser involved. The user's side is the page: what the
 * agent does has to show up there, and typing into a pane has to wait for the
 * user to allow it in that pane, through the same question `tmuxy pane send`
 * asks.
 */

const {
  createTestContext,
  waitForShellPrompt,
  waitForPaneCount,
  waitForTerminalText,
  waitForCondition,
} = require('./helpers');
const { TMUXY_URL } = require('./helpers/config');

/** An MCP client for one session: the handshake, then tool calls. */
async function mcpClient(session) {
  const url = `${TMUXY_URL}/mcp?session=${encodeURIComponent(session)}`;
  let sessionId = null;
  let nextId = 1;
  const rpc = async (method, params) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId && { 'mcp-session-id': sessionId }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e-agent', version: '1' },
  });
  return {
    /** A tool's answer, or its failure as an error. */
    call: async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
      return result.structuredContent;
    },
  };
}

/** A pane's box on screen, or null when it is not drawn. */
async function paneBox(page, paneId) {
  return page.evaluate((id) => {
    const r = document
      .querySelector(`[data-pane-id="${id}"] [role="log"]`)
      ?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null;
  }, paneId);
}

describe('Scenario: an MCP client sees and drives the session', () => {
  const ctx = createTestContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a split appears, a send waits for the user to allow it, the output is read back, the pane closes', async () => {
    if (ctx.skipIfNotReady()) return;
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    const agent = await mcpClient(ctx.session.name);

    // 1. Eyes: the agent sees the one pane the user sees.
    const { panes } = await agent.call('pane_list');
    expect(panes).toHaveLength(1);
    const userPane = panes[0].id;
    expect(panes[0].active).toBe(true);

    // 2. A split, drawn on the page, with the keyboard left where it was.
    const { paneId } = await agent.call('pane_split', { direction: 'right' });
    await waitForPaneCount(page, 2);
    await waitForCondition(page, () => paneBox(page, paneId), 15000, `${paneId} to be drawn`);
    expect((await agent.call('status')).activePane).toBe(userPane);

    // 3. Hands, with the user's permission. The send blocks on the question,
    //    which is drawn over the target pane naming the agent and the keys.
    const sending = agent.call('pane_send_keys', {
      pane: paneId,
      keys: ["echo 'mcp-e2e-#{ok}'", 'Enter'],
      timeout_seconds: 60,
    });
    const question = await waitForCondition(
      page,
      () =>
        page.evaluate((id) => {
          const el = document.querySelector(`[data-pane-ask="${id}"]`);
          const r = el?.querySelector('.ask-overlay-text')?.getBoundingClientRect();
          if (!r || r.width < 40 || r.height < 20) return null;
          return [...el.querySelectorAll('.ask-overlay-question')].map((q) => q.textContent);
        }, paneId),
      20000,
      `the question over ${paneId} to be readable`,
    );
    expect(question[0]).toBe("e2e-agent wants to send echo 'mcp-e2e-#{ok}'.Allow?");
    // Nothing is typed before the user answers: that is the point of asking.
    const before = await page.evaluate(
      (id) => document.querySelector(`[data-pane-id="${id}"] [role="log"]`)?.textContent ?? '',
      paneId,
    );
    expect(before).not.toContain('mcp-e2e-');
    await page.click(`[data-pane-ask="${paneId}"] [data-ask-choice="yes"]`);
    expect(await sending).toEqual({ paneId, sent: true, asked: true });

    // 4. The output lands — on the page, and in what the agent reads back.
    await waitForTerminalText(page, 'mcp-e2e-#{ok}', 20000, {
      scope: `[data-pane-id="${paneId}"]`,
      notOnLineWith: 'echo',
    });
    const seen = await agent.call('pane_wait_for', {
      pane: paneId,
      pattern: '^mcp-e2e-#\\{ok\\}$',
      timeout_seconds: 10,
    });
    expect(seen.line).toBe('mcp-e2e-#{ok}');

    // 5. Closed, and gone from the page.
    await agent.call('pane_kill', { pane: paneId });
    await waitForPaneCount(page, 1);
    expect(await paneBox(page, userPane)).not.toBeNull();
  }, 180000);
});

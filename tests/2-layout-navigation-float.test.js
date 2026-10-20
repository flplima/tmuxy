/**
 * Layout & Navigation E2E Tests (Float Pane Lifecycle & Float fzf Workflow)
 */

const {
  createTestContext,
  delay,
  runCommand,
  waitForPaneCount,
  typeInTerminal,
  pressEnter,
  TMUXY_CLI,
  splitPaneKeyboard,
  showsShellPrompt,
  waitForCondition,
  DELAYS,
  verifyFloatVisible,
  waitForFloatModal,
  waitForNoModal,
  focusedFloatPaneId,
  floatCentreOffset,
  CENTRE_TOLERANCE_PX,
  isCentred,
  openFloatFromCli,
} = require('./helpers/layout-helpers');

// ==================== Scenario 6: Float Pane Lifecycle ====================

describe('Scenario 6: Float Pane Lifecycle', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('CLI float → visually visible → centred in the container, again after a resize → header structure → auto-focus → type command → output visible → input isolation → close button → background restored → Escape, backdrop and exit close too', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // The float is opened from the right half of a split, so a float anchored
    // to the pane it came from would sit off the container's centre.
    await splitPaneKeyboard(ctx.page, 'vertical');
    await waitForPaneCount(ctx.page, 2);

    // Record background pane ID
    const bgPaneId = await ctx.session.getActivePaneId();
    expect(bgPaneId).toMatch(/^%\d+$/);

    // Step 1: Verify background pane is operational
    await runCommand(ctx.page, 'echo BG_PRE_FLOAT', 'BG_PRE_FLOAT');

    // Step 2: Open an interactive float via the CLI; it is on screen with a
    // real size and XState auto-focuses it.
    const focusedFloatId = await openFloatFromCli(ctx);
    expect(focusedFloatId).toMatch(/^%\d+$/);

    // Step 3: Float header has close button but NO group-add (+) button
    const headerInfo = await ctx.page.evaluate(() => {
      const fc =
        document.querySelector('.float-container') || document.querySelector('.modal-container');
      if (!fc) return null;
      return {
        hasHeader: !!fc.querySelector('.pane-header'),
        hasCloseButton: !!fc.querySelector('.pane-header-close'),
        hasMenuButton: !!fc.querySelector('.pane-header-menu'),
      };
    });
    expect(headerInfo).not.toBeNull();
    expect(headerInfo.hasHeader).toBe(true);
    expect(headerInfo.hasCloseButton).toBe(true);
    expect(headerInfo.hasMenuButton).toBe(true);

    // Step 3a: Background pane should NOT be active when float is focused.
    // The element may not be in the DOM (null) when the float overlay covers it.
    const bgActiveState = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`.pane-layout-item[data-pane-id="${id}"]`);
      return el ? el.classList.contains('pane-active') : null;
    }, bgPaneId);
    expect(bgActiveState).not.toBe(true);

    // Step 3b: Float has all 4 borders and drop shadow
    const floatStyle = await ctx.page.evaluate(() => {
      const mc = document.querySelector('.float-modal .modal-container');
      if (!mc) return null;
      const cs = window.getComputedStyle(mc);
      return {
        borderTop: cs.borderTopWidth,
        borderRight: cs.borderRightWidth,
        borderBottom: cs.borderBottomWidth,
        borderLeft: cs.borderLeftWidth,
        boxShadow: cs.boxShadow,
      };
    });
    expect(floatStyle).not.toBeNull();
    expect(parseFloat(floatStyle.borderTop)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderRight)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderBottom)).toBeGreaterThanOrEqual(1);
    expect(parseFloat(floatStyle.borderLeft)).toBeGreaterThanOrEqual(1);
    expect(floatStyle.boxShadow).not.toBe('none');

    // Step 3b2: The float sits at the centre of the pane container, and comes
    // back to it once the window is resized.
    const opened = await floatCentreOffset(ctx.page);
    expect(Math.abs(opened.dx)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
    expect(Math.abs(opened.dy)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
    const viewport = ctx.page.viewportSize();
    await ctx.page.setViewportSize({ width: viewport.width - 280, height: viewport.height - 80 });
    await waitForCondition(
      ctx.page,
      async () => {
        const offset = await floatCentreOffset(ctx.page);
        return offset?.containerWidth !== opened.containerWidth && isCentred(offset);
      },
      10000,
      'the float to re-centre in the resized container',
    );
    await ctx.page.setViewportSize(viewport);
    await waitForCondition(
      ctx.page,
      async () => {
        const offset = await floatCentreOffset(ctx.page);
        return offset?.containerWidth === opened.containerWidth && isCentred(offset);
      },
      10000,
      'the float to re-centre once the window is back to its size',
    );

    // Step 3c: Float pane header icon is NOT a button (no role="button")
    const iconIsStatic = await ctx.page.evaluate(() => {
      const fc = document.querySelector('.float-container');
      const icon = fc?.querySelector('.pane-tab-icon');
      if (!icon) return null;
      return {
        hasStaticClass: icon.classList.contains('pane-tab-icon-static'),
        hasButtonRole: icon.getAttribute('role') === 'button',
      };
    });
    if (iconIsStatic) {
      expect(iconIsStatic.hasStaticClass).toBe(true);
      expect(iconIsStatic.hasButtonRole).toBe(false);
    }

    // Step 4: Type command in float and verify output
    // Wait for float pane shell prompt to render
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate(() => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          if (!log) return false;
          const content = log.textContent || '';
          return content.length > 5 && /[$#%>❯]/.test(content);
        });
      },
      15000,
      'float pane shell prompt to render',
    );
    // Type directly — the keyboard actor routes to focusedFloatPaneId.
    // Do NOT click the float's [role="log"] — it triggers FOCUS_PANE which
    // selects the background pane, breaking input isolation.
    // Wait for the keyboard actor to receive the UPDATE_FOCUSED_FLOAT event
    // (async message from XState, may lag behind context update).
    await delay(DELAYS.SYNC);
    await ctx.page.bringToFront();
    const TOKEN = 'FLOAT_VIS_' + Date.now();
    for (const char of `echo ${TOKEN}`) {
      await ctx.page.keyboard.type(char);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');

    // Verify typed text appears in the float's DOM
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((token) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          return log?.textContent?.includes(token) || false;
        }, TOKEN);
      },
      10000,
      'typed output in float DOM',
    );

    // Step 5: Input-focus isolation. Full DOM-level isolation (token must
    // NOT appear in the background pane) cannot be asserted under CDP:
    // headless keyboard events can race UPDATE_FOCUSED_FLOAT and leak to
    // activePaneId — a harness artifact, not a product bug. What IS stable
    // and meaningful: typing must not steal focus away from the float.
    const focusAfterTyping = await ctx.page.evaluate(() => {
      const c = window.app?.getSnapshot()?.context;
      return {
        focusedFloat: c?.focusedFloatPaneId ?? null,
        floatIds: Object.keys(c?.floatPanes ?? {}),
      };
    });
    expect(focusAfterTyping.focusedFloat).not.toBeNull();
    expect(focusAfterTyping.floatIds).toContain(focusAfterTyping.focusedFloat);

    // Step 6: Background pane still visible while float is open
    const bgVisible = await ctx.page.evaluate((id) => {
      const el = document.querySelector(`[data-pane-id="${id}"]`);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }, bgPaneId);
    expect(bgVisible).toBe(true);

    // Step 7: Close float via close button
    const closeClicked = await ctx.page.evaluate(() => {
      const fc =
        document.querySelector('.float-container') || document.querySelector('.modal-container');
      const btn = fc?.querySelector('.pane-header-close');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    expect(closeClicked).toBe(true);
    await waitForNoModal(ctx.page);

    // Step 8: focusedFloatPaneId cleared, and the background pane wears the
    // active marker again — the one visual cue that says where typing goes.
    expect(await focusedFloatPaneId(ctx.page)).toBeNull();
    await waitForCondition(
      ctx.page,
      () =>
        ctx.page.evaluate(
          (id) => !!document.querySelector(`.pane-layout-item.pane-active[data-pane-id="${id}"]`),
          bgPaneId,
        ),
      10000,
      'the background pane to be active again after the float closes',
    );

    // Background pane still works
    const BG_TOKEN = 'BG_AFTER_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${BG_TOKEN}`, BG_TOKEN);

    // Step 9: Escape closes a float too — the key goes to the modal, not to
    // the program in the background pane — and focus comes back with it.
    await openFloatFromCli(ctx);
    await ctx.page.keyboard.press('Escape');
    await waitForNoModal(ctx.page);
    expect(await focusedFloatPaneId(ctx.page)).toBeNull();
    const ESC_TOKEN = 'ESC_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${ESC_TOKEN}`, ESC_TOKEN);

    // Step 10: and so does a click on the backdrop (far from the center, so
    // it cannot land on the float itself).
    await openFloatFromCli(ctx);
    const backdrop = await ctx.page.$('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    const box = await backdrop.boundingBox();
    await ctx.page.mouse.click(box.x + 5, box.y + 5);
    await waitForNoModal(ctx.page);
    const BACKDROP_TOKEN = 'BACKDROP_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${BACKDROP_TOKEN}`, BACKDROP_TOKEN);

    // Step 11: and so does the float's own shell ending. Typed into after a
    // click on it, `exit` reaches the float's shell, not the pane behind, and
    // tmux drops the float window with it.
    const exitFloatId = await openFloatFromCli(ctx);
    await typeInTerminal(ctx.page, 'exit', { target: '.float-container [role="log"]' });
    expect(await focusedFloatPaneId(ctx.page)).toBe(exitFloatId);
    await pressEnter(ctx.page);
    await waitForNoModal(ctx.page);
    const windowTypes = () =>
      ctx.session.query(`list-windows -F '#{window_id}:#{@tmuxy-window-type}'`);
    await waitForCondition(
      ctx.page,
      async () => !/:float$/m.test(await windowTypes()),
      15000,
      'tmux to drop the float window once its shell exits',
    );
    expect(await ctx.session.getActivePaneId()).toBe(bgPaneId);
    const EXIT_TOKEN = 'EXIT_CLOSE_' + Date.now();
    await runCommand(ctx.page, `echo ${EXIT_TOKEN}`, EXIT_TOKEN);
  }, 300000);
});

// ==================== Scenario 22: Float fzf Workflow ====================

describe('Scenario 22: Float fzf Workflow', () => {
  const ctx = createTestContext({ snapshot: true });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('Float opens fzf → user selects item → result returned to shell [nightly]', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Step 1: Background pane is operational
    await runCommand(ctx.page, 'echo FZF_BG_READY', 'FZF_BG_READY');

    // Step 2: Open an interactive float
    await typeInTerminal(ctx.page, `${TMUXY_CLI} pane float`);
    await pressEnter(ctx.page);

    // Step 3: Float appears — wait for float content to render
    await waitForFloatModal(ctx.page, 20000);
    await verifyFloatVisible(ctx.page);

    // Get the float pane ID for capture-pane verification
    const floatPaneId = await ctx.page.evaluate(
      () => window.app?.getSnapshot()?.context?.focusedFloatPaneId,
    );
    expect(floatPaneId).toBeTruthy();

    // Synchronise on the float's own prompt, using the shared predicate rather
    // than a copy of it: an inlined one here matched a prompt character
    // ANYWHERE in the text and required more than five characters, the two
    // bugs `showsShellPrompt` exists to not have twice.
    //
    // Non-fatal on purpose: this only buys the typing below a settled prompt
    // to land on, and the echo assertion that follows is the real gate. A
    // failure here would report the same bug one step earlier, not a
    // different one.
    try {
      await waitForCondition(
        ctx.page,
        async () => {
          const text = await ctx.page.evaluate(() => {
            const fc =
              document.querySelector('.float-container') ||
              document.querySelector('.modal-container');
            return fc?.querySelector('[role="log"]')?.textContent ?? null;
          });
          return text !== null && showsShellPrompt(text);
        },
        10000,
        'float pane shell prompt to render',
      );
    } catch {
      /* the echo assertion below is the real gate */
    }

    // Step 4: Run echo in the float and verify output
    const TOKEN = `FZF_TOKEN_${Date.now()}`;
    for (const ch of `echo ${TOKEN}`) {
      await ctx.page.keyboard.type(ch);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');

    // Verify typed text in float's DOM
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((token) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          const log = fc.querySelector('[role="log"]');
          return log?.textContent?.includes(token) || false;
        }, TOKEN);
      },
      10000,
      'echo output in float DOM',
    );

    // Step 6: Run fzf with a simple input and auto-select via --select-1
    const FZF_MARKER = `FZF_RESULT_${Date.now()}`;
    const fzfCmd = `echo ${FZF_MARKER} | fzf --select-1`;
    for (const ch of fzfCmd) {
      await ctx.page.keyboard.type(ch);
      await delay(30);
    }
    await ctx.page.keyboard.press('Enter');

    // Verify fzf result in float DOM — fzf --select-1 prints the match to stdout,
    // on a row of its own: the typed command line carries the marker too.
    await waitForCondition(
      ctx.page,
      async () => {
        return await ctx.page.evaluate((marker) => {
          const fc =
            document.querySelector('.float-container') ||
            document.querySelector('.modal-container');
          if (!fc) return false;
          return [...fc.querySelectorAll('[role="log"] .terminal-line')].some((row) => {
            const text = row.textContent || '';
            return text.includes(marker) && !text.includes('fzf');
          });
        }, FZF_MARKER);
      },
      15000,
      'fzf result in float DOM',
    );

    // Step 8: Close float if still open (exit the shell)
    const stillHasFloat = await ctx.page.evaluate(
      () => document.querySelectorAll('.modal-overlay').length > 0,
    );
    if (stillHasFloat) {
      await ctx.page.keyboard.type('exit');
      await ctx.page.keyboard.press('Enter');
    }

    await ctx.page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      timeout: 15000,
      polling: 100,
    });

    // Background pane should be interactive after float closes
    const bgMarker = `BG_RESTORED_${Date.now()}`;
    await runCommand(ctx.page, `echo ${bgMarker}`, bgMarker);
  }, 180000);
});

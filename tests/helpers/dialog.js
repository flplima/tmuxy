/**
 * A dialog (components/Modal.tsx) as drawn: in the middle of the window both
 * ways, and set in the terminal's font, its buttons too.
 */

async function expectDialogCentredInMonospace(page) {
  const look = await page.evaluate(() => {
    const box = document.querySelector('.modal-overlay-centered .modal-container');
    const rect = box.getBoundingClientRect();
    const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono');
    return {
      dx: Math.abs(rect.left + rect.width / 2 - innerWidth / 2),
      dy: Math.abs(rect.top + rect.height / 2 - innerHeight / 2),
      font: getComputedStyle(box).fontFamily,
      mono,
      buttonFont: getComputedStyle(box.querySelector('.app-menu-dialog-actions button')).fontFamily,
    };
  });
  const unquoted = (family) => family.replace(/['"]/g, '').trim();
  expect(look.dx).toBeLessThan(3);
  expect(look.dy).toBeLessThan(3);
  expect(unquoted(look.font)).toBe(unquoted(look.mono));
  expect(unquoted(look.buttonFont)).toBe(unquoted(look.mono));
}

module.exports = { expectDialogCentredInMonospace };

/**
 * The SVG icon in a pane's header tab, as drawn: a screenshot of it read
 * pixel by pixel (`at(x, y)`, fractions of the box), the colour its text
 * would be, the header's background beside it, whether the box is inside
 * its tab, and whether the SVG's shape is inside its own viewBox. `null`
 * until the icon is on screen.
 */
async function iconPixels(page, paneId) {
  const info = await page.evaluate((id) => {
    const el = document.querySelector(`[data-pane-tab="${id}"] .process-icon-svg`);
    const tab = el?.closest('.pane-tab');
    const box = el?.getBoundingClientRect();
    if (!el || !tab || !box || box.width === 0) return null;
    const tabBox = tab.getBoundingClientRect();
    const url = /url\("(.*)"\)/.exec(
      getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage,
    )?.[1];
    if (!url) return null;
    const comma = url.indexOf(',');
    const body = url.slice(comma + 1);
    const svg = url.slice(0, comma).endsWith(';base64') ? atob(body) : decodeURIComponent(body);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-9999px;width:64px;height:64px';
    host.innerHTML = svg;
    document.body.append(host);
    const root = host.querySelector('svg');
    const view = root.viewBox.baseVal;
    const shape = root.getBBox();
    host.remove();
    const slack = 0.01;
    const rgb = (value) => {
      const probe = document.createElement('canvas').getContext('2d');
      probe.fillStyle = value;
      const hex = probe.fillStyle.slice(1);
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    };
    const icon = el.parentElement;
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      inTab:
        box.left >= tabBox.left &&
        box.right <= tabBox.right &&
        box.top >= tabBox.top &&
        box.bottom <= tabBox.bottom,
      shapeInViewBox:
        shape.x >= view.x - slack &&
        shape.y >= view.y - slack &&
        shape.x + shape.width <= view.x + view.width + slack &&
        shape.y + shape.height <= view.y + view.height + slack,
      text: rgb(getComputedStyle(el).backgroundColor),
      opacity: Number(getComputedStyle(icon).opacity),
      scale: window.devicePixelRatio,
    };
  }, paneId);
  if (!info) return null;
  const { box } = info;
  // One pixel to the left of the box is the header behind the icon.
  const png = await page.screenshot({
    clip: { x: box.x - 2, y: box.y, width: box.width + 2, height: box.height },
  });
  const shot = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const c = canvas.getContext('2d');
    c.drawImage(img, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: [...c.getImageData(0, 0, canvas.width, canvas.height).data],
    };
  }, png.toString('base64'));
  const pad = Math.round((shot.width * 2) / (box.width + 2));
  const width = shot.width - pad;
  const pixel = (px, py) => {
    const i = (py * shot.width + px) * 4;
    return [shot.data[i], shot.data[i + 1], shot.data[i + 2]];
  };
  const at = (x, y) =>
    pixel(
      pad + Math.min(width - 1, Math.floor(x * width)),
      Math.min(shot.height - 1, Math.floor(y * shot.height)),
    );
  return {
    ...info,
    at,
    background: pixel(0, Math.floor(shot.height / 2)),
    width,
    height: shot.height,
  };
}

module.exports = { iconPixels };

/**
 * TabShot — a tab's pane layout drawn to scale, as a picture of it.
 *
 * Shared by the Tab Overview's cards and the hover preview, which want the
 * same thing: each pane's screen at its natural cell size, scaled into its
 * share of a frame, so the picture reads as the tab's layout rather than as a
 * wireframe of it.
 *
 * The frame's pixel size has to be measured by the caller and passed in —
 * every box is positioned as a percentage of it, and the scale each pane's
 * screen needs comes from the same number. Until it is known the boxes fall
 * back to their labels, which is what the first render draws.
 */

import { Terminal } from './Terminal';
import type { SlotBox } from '../utils/tabOverview';

interface TabShotProps {
  boxes: readonly SlotBox[];
  /** The frame's measured pixel box; null until the caller has measured it. */
  frameSize: { width: number; height: number } | null;
  charWidth: number;
  charHeight: number;
}

export function TabShot({ boxes, frameSize, charWidth, charHeight }: TabShotProps) {
  return (
    <>
      {boxes.map((box) => {
        // The pane's screen at its natural cell size, scaled into the box
        // (each axis on its own, so it fills the box the way the pane fills
        // its share of the tab).
        const naturalW = box.cols * charWidth;
        const naturalH = box.rows * charHeight;
        const shot =
          frameSize && naturalW > 0 && naturalH > 0
            ? {
                width: naturalW,
                height: naturalH,
                transform: `scale(${(frameSize.width * box.width) / 100 / naturalW}, ${
                  (frameSize.height * box.height) / 100 / naturalH
                })`,
              }
            : null;
        return (
          <div
            key={box.paneId}
            className={`tab-overview-box${box.active ? ' is-active' : ''}`}
            style={{
              left: `${box.left}%`,
              top: `${box.top}%`,
              width: `${box.width}%`,
              height: `${box.height}%`,
            }}
          >
            {shot ? (
              <div className="tab-overview-shot" style={shot}>
                <Terminal
                  content={box.content}
                  width={box.cols}
                  height={box.rows}
                  isActive={false}
                  paneId={box.paneId}
                />
              </div>
            ) : (
              <span className="tab-overview-box-label">{box.label}</span>
            )}
          </div>
        );
      })}
    </>
  );
}

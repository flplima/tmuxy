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
import { getTabIcon, getTabLabel } from './paneTabDisplay';
import type { SlotBox } from '../utils/tabOverview';
import type { TmuxPane } from '../tmux/types';

interface TabShotProps {
  boxes: readonly SlotBox[];
  /** The frame's measured pixel box; null until the caller has measured it. */
  frameSize: { width: number; height: number } | null;
  charWidth: number;
  charHeight: number;
  /**
   * Caption each pane with the icon and title its own header shows. Pass the
   * panes to turn it on: the picture then reads as the tab does, which is the
   * point of a preview. The all-tabs grid leaves it off — a wall of cards is
   * about which tab, not which pane.
   */
  panes?: readonly TmuxPane[];
}

export function TabShot({ boxes, frameSize, charWidth, charHeight, panes }: TabShotProps) {
  return (
    <>
      {boxes.map((box) => {
        const pane = panes?.find((p) => p.tmuxId === box.paneId);
        const icon = pane ? getTabIcon(pane) : null;
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
            {pane && shot && (
              // The pane's real header, drawn at the pane's real size and put
              // through the same scale as its screen. Reusing the markup is
              // the point: a miniature that invents its own title bar stops
              // looking like the tab it is a picture of the moment either one
              // changes.
              <div
                className="tab-shot-header"
                style={{ width: shot.width, transform: shot.transform }}
              >
                <div className={`pane-header${box.active ? ' pane-header-active' : ''}`}>
                  <div className={`pane-tab${box.active ? ' pane-tab-active' : ''}`}>
                    {icon && <span className="pane-tab-icon pane-tab-icon-static">{icon}</span>}
                    <span className="pane-tab-title">{getTabLabel(pane)}</span>
                  </div>
                </div>
              </div>
            )}
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

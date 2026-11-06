/**
 * The caller measures the frame's pixel size and passes it in: each pane's
 * scale comes from it. Until it is known the boxes show their labels.
 */

import { Terminal } from './terminal/Terminal';
import { PaneTab } from './PaneTab';
import type { SlotBox } from '../domain/tabOverview';
import type { TmuxPane } from '../domain/client';

interface TabShotProps {
  boxes: readonly SlotBox[];
  frameSize: { width: number; height: number } | null;
  charWidth: number;
  charHeight: number;
  /** Pass the panes to caption each one with its own header. */
  panes?: readonly TmuxPane[];
}

export function TabShot({ boxes, frameSize, charWidth, charHeight, panes }: TabShotProps) {
  return (
    <>
      {boxes.map((box) => {
        const pane = panes?.find((p) => p.tmuxId === box.paneId);
        // Each axis scales on its own, so the screen fills the box the way the
        // pane fills its share of the tab.
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
              <div
                className="tab-shot-header"
                style={{ width: shot.width, transform: shot.transform }}
              >
                <div className={`pane-header${box.active ? ' pane-header-active' : ''}`}>
                  <PaneTab pane={pane} isActivePane={box.active} still />
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
                  links={false}
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

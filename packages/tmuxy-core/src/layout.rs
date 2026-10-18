//! tmux window layouts as a tree — for the collapsible-panes feature.
//!
//! tmux describes a window's layout as `checksum,WxH,X,Y` followed by a pane
//! id (a leaf), `[…]` (cells stacked top to bottom) or `{…}` (cells side by
//! side). `select-layout` accepts the same string back, checksum included, so
//! the backend can reshape a window precisely by editing the tree and
//! serialising it again.
//!
//! Collapsible panes act on the FIRST level only: when the root is a vertical
//! stack, every first-level row except the one holding the active pane shrinks
//! to its minimum height (one row per pane, so the UI shows just the header),
//! and the active row takes the rest. Anything nested inside a row keeps its
//! own proportions, so navigating between nested panes never reshapes the
//! window. Turning the feature off evens the first-level rows out.

use crate::ids::PaneId;

/// A layout's shape without its sizes: which panes share which split. The
/// client reads it to know what a divider drag moves — tmux resizes along
/// the tree, so in an even 2×2 grid the panes a drag moves depend on whether
/// the root splits into columns or rows, which the geometry alone cannot
/// tell apart.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum PaneTree {
    Pane(PaneId),
    Split {
        /// Children stacked top to bottom (`[`), else side by side (`{`).
        vertical: bool,
        children: Vec<PaneTree>,
    },
}

/// One cell of a layout tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Leaf {
        w: u32,
        h: u32,
        x: u32,
        y: u32,
        pane: u32,
    },
    Split {
        w: u32,
        h: u32,
        x: u32,
        y: u32,
        /// `[`: children stacked top to bottom. `{`: side by side.
        vertical: bool,
        children: Vec<Node>,
    },
}

impl Node {
    fn w(&self) -> u32 {
        match self {
            Node::Leaf { w, .. } | Node::Split { w, .. } => *w,
        }
    }
    fn h(&self) -> u32 {
        match self {
            Node::Leaf { h, .. } | Node::Split { h, .. } => *h,
        }
    }

    /// The smallest height this cell can take: one row per stacked pane plus
    /// the border rows between them.
    pub fn min_height(&self) -> u32 {
        match self {
            Node::Leaf { .. } => 1,
            Node::Split {
                vertical, children, ..
            } => {
                if *vertical {
                    children.iter().map(Node::min_height).sum::<u32>()
                        + children.len().saturating_sub(1) as u32
                } else {
                    children.iter().map(Node::min_height).max().unwrap_or(1)
                }
            }
        }
    }

    /// This cell's shape, without sizes (see `PaneTree`).
    pub fn pane_tree(&self) -> PaneTree {
        match self {
            Node::Leaf { pane, .. } => PaneTree::Pane(PaneId::from_number(*pane)),
            Node::Split {
                vertical, children, ..
            } => PaneTree::Split {
                vertical: *vertical,
                children: children.iter().map(Node::pane_tree).collect(),
            },
        }
    }

    pub fn contains_pane(&self, pane: u32) -> bool {
        match self {
            Node::Leaf { pane: p, .. } => *p == pane,
            Node::Split { children, .. } => children.iter().any(|c| c.contains_pane(pane)),
        }
    }

    /// Give this cell a new box, scaling nested stacks proportionally and
    /// keeping every invariant `select-layout` checks: stacked heights plus
    /// borders equal the parent's, side-by-side widths likewise.
    fn fit(&mut self, w: u32, h: u32, x: u32, y: u32) {
        match self {
            Node::Leaf {
                w: cw,
                h: ch,
                x: cx,
                y: cy,
                ..
            } => {
                *cw = w;
                *ch = h;
                *cx = x;
                *cy = y;
            }
            Node::Split {
                w: cw,
                h: ch,
                x: cx,
                y: cy,
                vertical,
                children,
            } => {
                *cw = w;
                *ch = h;
                *cx = x;
                *cy = y;
                let n = children.len() as u32;
                if *vertical {
                    let sizes = distribute(
                        children.iter().map(Node::h).collect(),
                        children.iter().map(Node::min_height).collect(),
                        h.saturating_sub(n.saturating_sub(1)),
                    );
                    let mut cy = y;
                    for (child, size) in children.iter_mut().zip(sizes) {
                        child.fit(w, size, x, cy);
                        cy += size + 1;
                    }
                } else {
                    let sizes = distribute(
                        children.iter().map(Node::w).collect(),
                        vec![1; children.len()],
                        w.saturating_sub(n.saturating_sub(1)),
                    );
                    let mut cx = x;
                    for (child, size) in children.iter_mut().zip(sizes) {
                        child.fit(size, h, cx, y);
                        cx += size + 1;
                    }
                }
            }
        }
    }
}

/// Scale `current` sizes to sum to `total`, never below each cell's minimum,
/// with rounding leftovers going to the last cell.
fn distribute(current: Vec<u32>, mins: Vec<u32>, total: u32) -> Vec<u32> {
    let n = current.len();
    if n == 0 {
        return Vec::new();
    }
    let sum: u32 = current.iter().sum::<u32>().max(1);
    let mut out: Vec<u32> = current
        .iter()
        .map(|c| ((*c as u64 * total as u64) / sum as u64) as u32)
        .zip(&mins)
        .map(|(v, m)| v.max(*m))
        .collect();
    let used: u32 = out.iter().sum();
    if used < total {
        out[n - 1] += total - used;
    } else if used > total {
        // Minimums overshot: trim the largest cells down to what fits.
        let mut excess = used - total;
        for i in (0..n).rev() {
            let room = out[i].saturating_sub(mins[i]);
            let cut = room.min(excess);
            out[i] -= cut;
            excess -= cut;
            if excess == 0 {
                break;
            }
        }
    }
    out
}

/// tmux's layout checksum (`layout_checksum` in layout-custom.c).
pub fn checksum(body: &str) -> u16 {
    let mut csum: u16 = 0;
    for b in body.bytes() {
        csum = (csum >> 1).wrapping_add((csum & 1) << 15);
        csum = csum.wrapping_add(b as u16);
    }
    csum
}

/// Parse a layout string, with or without its checksum prefix — or the JSON
/// form tmux 3.8 prints for `#{window_layout}` (see [`parse_json`]).
pub fn parse(layout: &str) -> Option<Node> {
    if layout.trim_start().starts_with('{') {
        return parse_json(layout);
    }
    let body = match layout.split_once(',') {
        Some((head, rest)) if head.len() == 4 && head.bytes().all(|b| b.is_ascii_hexdigit()) => {
            rest
        }
        _ => layout,
    };
    let bytes = body.as_bytes();
    let mut i = 0;
    let node = parse_cell(bytes, &mut i)?;
    (i == bytes.len()).then_some(node)
}

fn parse_num(bytes: &[u8], i: &mut usize) -> Option<u32> {
    let start = *i;
    while *i < bytes.len() && bytes[*i].is_ascii_digit() {
        *i += 1;
    }
    std::str::from_utf8(&bytes[start..*i]).ok()?.parse().ok()
}

fn expect(bytes: &[u8], i: &mut usize, c: u8) -> Option<()> {
    if bytes.get(*i) == Some(&c) {
        *i += 1;
        Some(())
    } else {
        None
    }
}

fn parse_cell(bytes: &[u8], i: &mut usize) -> Option<Node> {
    let w = parse_num(bytes, i)?;
    expect(bytes, i, b'x')?;
    let h = parse_num(bytes, i)?;
    expect(bytes, i, b',')?;
    let x = parse_num(bytes, i)?;
    expect(bytes, i, b',')?;
    let y = parse_num(bytes, i)?;
    match bytes.get(*i) {
        Some(b',') => {
            *i += 1;
            let pane = parse_num(bytes, i)?;
            Some(Node::Leaf { w, h, x, y, pane })
        }
        Some(&open @ (b'[' | b'{')) => {
            *i += 1;
            let close = if open == b'[' { b']' } else { b'}' };
            let mut children = Vec::new();
            loop {
                children.push(parse_cell(bytes, i)?);
                match bytes.get(*i) {
                    Some(b',') => *i += 1,
                    Some(&c) if c == close => {
                        *i += 1;
                        break;
                    }
                    _ => return None,
                }
            }
            Some(Node::Split {
                w,
                h,
                x,
                y,
                vertical: open == b'[',
                children,
            })
        }
        _ => None,
    }
}

/// The JSON layout tmux 3.8 prints for `#{window_layout}`:
/// `{"V":2,"L":cell}`, a cell being `{"t":"p"|"h"|"v","w","h","x","y",…}`
/// with `"I":"%N"` on a pane and `"c":[cells]` on a split (`"h"` side by
/// side, `"v"` stacked). `%layout-change` still carries the classic string,
/// and only 3.8 reads the JSON back — so it is turned into the classic tree,
/// which every supported tmux takes through `select-layout`.
pub fn parse_json(layout: &str) -> Option<Node> {
    let value: serde_json::Value = serde_json::from_str(layout).ok()?;
    json_cell(value.get("L")?)
}

fn json_cell(cell: &serde_json::Value) -> Option<Node> {
    let num = |key: &str| cell.get(key)?.as_u64().and_then(|n| u32::try_from(n).ok());
    let (w, h, x, y) = (num("w")?, num("h")?, num("x")?, num("y")?);
    match cell.get("t")?.as_str()? {
        "p" => {
            let pane = cell.get("I")?.as_str()?.strip_prefix('%')?.parse().ok()?;
            Some(Node::Leaf { w, h, x, y, pane })
        }
        kind @ ("h" | "v") => Some(Node::Split {
            w,
            h,
            x,
            y,
            vertical: kind == "v",
            children: cell
                .get("c")?
                .as_array()?
                .iter()
                .map(json_cell)
                .collect::<Option<Vec<_>>>()?,
        }),
        _ => None,
    }
}

fn serialize_body(node: &Node, out: &mut String) {
    match node {
        Node::Leaf { w, h, x, y, pane } => out.push_str(&format!("{w}x{h},{x},{y},{pane}")),
        Node::Split {
            w,
            h,
            x,
            y,
            vertical,
            children,
        } => {
            out.push_str(&format!("{w}x{h},{x},{y}"));
            out.push(if *vertical { '[' } else { '{' });
            for (k, child) in children.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                serialize_body(child, out);
            }
            out.push(if *vertical { ']' } else { '}' });
        }
    }
}

/// The layout string `select-layout` accepts: checksum, then the tree.
pub fn serialize(node: &Node) -> String {
    let mut body = String::new();
    serialize_body(node, &mut body);
    format!("{:04x},{}", checksum(&body), body)
}

/// Heights of the first-level rows when the root is a vertical stack.
pub fn first_level_heights(layout: &str) -> Option<Vec<u32>> {
    match parse(layout)? {
        Node::Split {
            vertical: true,
            children,
            ..
        } => Some(children.iter().map(Node::h).collect()),
        _ => None,
    }
}

/// The height to give a collapsed first-level row: one row of content, plus
/// one more for the row at the very top of the window.
///
/// tmuxy runs with `pane-border-status top`, so every pane has a status line
/// drawn on its top border. For all but the topmost row that line sits on the
/// separator the layout already reserves between rows. The top row has no
/// separator above it, so tmux takes the line out of the pane itself — ask
/// for one row there and the pane is left with nothing to show, which is why
/// the first pane of a stack came out as a bare header.
fn collapsed_height(index: usize, node: &Node) -> u32 {
    node.min_height() + u32::from(index == 0)
}

/// The layout with every first-level row but the one holding `active_pane`
/// collapsed to its minimum height. None when the root is not a vertical
/// stack, the active pane is not in it, the rows already have these heights,
/// or the window is too short to hold the collapsed rows.
pub fn collapse_first_level(layout: &str, active_pane: u32) -> Option<String> {
    let mut root = parse(layout)?;
    let Node::Split {
        w,
        h,
        x,
        y,
        vertical: true,
        children,
    } = &mut root
    else {
        return None;
    };
    let active = children.iter().position(|c| c.contains_pane(active_pane))?;
    let (w, h, x, y) = (*w, *h, *x, *y);
    let n = children.len() as u32;
    let collapsed: u32 = children
        .iter()
        .enumerate()
        .filter(|(k, _)| *k != active)
        .map(|(k, c)| collapsed_height(k, c))
        .sum();
    let expanded = h.checked_sub(n - 1)?.checked_sub(collapsed)?;
    if expanded < collapsed_height(active, &children[active]) {
        return None;
    }
    let targets: Vec<u32> = children
        .iter()
        .enumerate()
        .map(|(k, c)| {
            if k == active {
                expanded
            } else {
                collapsed_height(k, c)
            }
        })
        .collect();
    if collapsed_in_shape(children, &targets, active) {
        return None;
    }
    let mut cy = y;
    for (child, size) in children.iter_mut().zip(targets) {
        child.fit(w, size, x, cy);
        cy += size + 1;
    }
    Some(serialize(&root))
}

/// Whether a collapsed stack already has the target heights.
///
/// Exact for the collapsed rows: they are one or two lines tall, so a line
/// out is the difference between a pane that shows a line of its content and
/// one that shows none. The expanded row is allowed a line either way —
/// whatever tmux adjusts lands there, and matching it exactly would re-send
/// the same request after every layout change it produced.
fn collapsed_in_shape(children: &[Node], targets: &[u32], active: usize) -> bool {
    children.iter().zip(targets).enumerate().all(|(k, (c, t))| {
        if k == active {
            c.h().abs_diff(*t) <= 1
        } else {
            c.h() == *t
        }
    })
}

/// Whether the rows already have (within one line of) the target heights.
/// Used for evening out, where every row is many lines tall and a line either
/// way is invisible — while an exact comparison would re-send the same
/// request after every layout change it produced.
fn in_shape(children: &[Node], targets: &[u32]) -> bool {
    children
        .iter()
        .zip(targets)
        .all(|(c, t)| c.h().abs_diff(*t) <= 1)
}

/// The layout with the first-level rows sharing the height evenly (the
/// remainder goes to the first rows, as tmux's own even-vertical does). None
/// when the root is not a vertical stack, the rows are already even, or a row
/// cannot fit its share.
pub fn even_first_level(layout: &str) -> Option<String> {
    let mut root = parse(layout)?;
    let Node::Split {
        w,
        h,
        x,
        y,
        vertical: true,
        children,
    } = &mut root
    else {
        return None;
    };
    let (w, h, x, y) = (*w, *h, *x, *y);
    let n = children.len() as u32;
    let avail = h.checked_sub(n - 1)?;
    let base = avail / n;
    let rem = avail % n;
    let targets: Vec<u32> = (0..n).map(|k| base + u32::from(k < rem)).collect();
    if children
        .iter()
        .zip(&targets)
        .any(|(c, t)| c.min_height() > *t)
    {
        return None;
    }
    if in_shape(children, &targets) {
        return None;
    }
    let mut cy = y;
    for (child, size) in children.iter_mut().zip(targets) {
        child.fit(w, size, x, cy);
        cy += size + 1;
    }
    Some(serialize(&root))
}

#[cfg(test)]
mod tests;

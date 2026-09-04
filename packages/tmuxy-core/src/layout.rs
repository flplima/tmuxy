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

/// Parse a layout string, with or without its checksum prefix.
pub fn parse(layout: &str) -> Option<Node> {
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
        .map(|(_, c)| c.min_height())
        .sum();
    let expanded = h.checked_sub(n - 1)?.checked_sub(collapsed)?;
    if expanded < children[active].min_height() {
        return None;
    }
    let targets: Vec<u32> = children
        .iter()
        .enumerate()
        .map(|(k, c)| {
            if k == active {
                expanded
            } else {
                c.min_height()
            }
        })
        .collect();
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

/// Whether the rows already have (within one line of) the target heights.
/// tmux adjusts what it is asked for — with `pane-border-status` the window's
/// top row keeps an extra line for its status — so an exact comparison would
/// re-send the same request after every layout change it produced.
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
mod tests {
    use super::*;

    // Reported by tmux 3.7c for a 159x48 window split right, then the right
    // half split below — checksum included, so serialising must reproduce it.
    const MANUAL: &str = "adc3,159x48,0,0{79x48,0,0,0,79x48,80,0[79x24,80,0,1,79x23,80,25,2]}";

    #[test]
    fn round_trips_the_manual_example_with_its_checksum() {
        let node = parse(MANUAL).expect("parses");
        assert_eq!(serialize(&node), MANUAL);
        // A checksum-less string parses too and gets one on the way out.
        let bare = parse("159x48,0,0,1").expect("parses");
        assert_eq!(
            serialize(&bare),
            format!("{:04x},159x48,0,0,1", checksum("159x48,0,0,1"))
        );
    }

    #[test]
    fn collapses_every_first_level_row_but_the_active_one() {
        // Three stacked rows of 10 in a 32-row window; the middle row is a
        // side-by-side pair.
        let layout =
            "0000,80x32,0,0[80x10,0,0,1,80x10,0,11{40x10,0,11,2,39x10,41,11,3},80x10,0,22,4]";
        let out = collapse_first_level(layout, 3).expect("relayout");
        let node = parse(&out).expect("parses back");
        assert_eq!(first_level_heights(&out), Some(vec![1, 28, 1]));
        // The nested pair kept its widths and took the row's full height.
        let Node::Split { children, .. } = &node else {
            panic!()
        };
        let Node::Split { children: pair, .. } = &children[1] else {
            panic!()
        };
        assert_eq!(pair.iter().map(Node::w).collect::<Vec<_>>(), vec![40, 39]);
        assert!(pair.iter().all(|c| c.h() == 28));
        // Offsets are recomputed top to bottom.
        let Node::Leaf { y, .. } = &children[2] else {
            panic!()
        };
        assert_eq!(*y, 31);
        // Applying the same rule again is a no-op.
        assert_eq!(collapse_first_level(&out, 3), None);
        assert_eq!(collapse_first_level(&out, 2), None);
    }

    #[test]
    fn tmux_keeping_a_status_line_on_the_top_row_counts_as_in_shape() {
        // Asked for [1, 28, 1], tmux reports [2, 27, 1]: the top row holds its
        // border-status line. Re-sending would loop forever.
        let layout = "0000,80x32,0,0[80x2,0,0,1,80x27,0,3,2,80x1,0,31,3]";
        assert_eq!(collapse_first_level(layout, 2), None);
    }

    #[test]
    fn a_nested_stack_collapses_to_one_row_per_pane() {
        let layout = "0000,80x32,0,0[80x15,0,0[80x7,0,0,1,80x7,0,8,2],80x16,0,16,3]";
        let out = collapse_first_level(layout, 3).expect("relayout");
        assert_eq!(first_level_heights(&out), Some(vec![3, 28]));
    }

    #[test]
    fn nothing_to_do_for_side_by_side_roots_or_foreign_panes() {
        assert_eq!(collapse_first_level(MANUAL, 1), None);
        let layout = "0000,80x32,0,0[80x15,0,0,1,80x16,0,16,2]";
        assert_eq!(collapse_first_level(layout, 9), None);
    }

    #[test]
    fn evens_the_first_level_out_and_leaves_nested_proportions() {
        let layout = "0000,80x32,0,0[80x1,0,0,1,80x28,0,2{40x28,0,2,2,39x28,41,2,3},80x1,0,31,4]";
        let out = even_first_level(layout).expect("relayout");
        assert_eq!(first_level_heights(&out), Some(vec![10, 10, 10]));
        assert_eq!(even_first_level(&out), None);
    }

    #[test]
    fn refuses_a_window_too_short_for_its_rows() {
        let layout = "0000,80x3,0,0[80x1,0,0,1,80x1,0,2,2]";
        assert_eq!(collapse_first_level(layout, 1), None);
        assert_eq!(even_first_level(layout), None);
    }
}

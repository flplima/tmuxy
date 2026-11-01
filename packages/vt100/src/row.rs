
/// DEC line-wide size attribute set by `ESC # 3`..`ESC # 6` (DECDHL / DECDWL / DECSWL).
#[derive(Copy, Clone, Debug, Default, Eq, PartialEq)]
pub enum LineSize {
    /// Normal single-width, single-height line (`ESC # 5` / default).
    #[default]
    Single,
    /// Double-width, single-height line (`ESC # 6` / DECDWL).
    DoubleWidth,
    /// Double-height, double-width top half (`ESC # 3` / DECDHL top).
    DoubleHeightTop,
    /// Double-height, double-width bottom half (`ESC # 4` / DECDHL bottom).
    DoubleHeightBottom,
}

#[derive(Clone, Debug)]
pub struct Row {
    cells: Vec<crate::Cell>,
    wrapped: bool,
    line_size: LineSize,
}

impl Row {
    pub fn new(cols: u16) -> Self {
        Self {
            cells: vec![crate::Cell::new(); usize::from(cols)],
            wrapped: false,
            line_size: LineSize::Single,
        }
    }

    pub fn line_size(&self) -> LineSize {
        self.line_size
    }

    pub fn set_line_size(&mut self, size: LineSize) {
        self.line_size = size;
    }

    fn cols(&self) -> u16 {
        self.cells
            .len()
            .try_into()
            // we limit the number of cols to a u16 (see Size)
            .unwrap()
    }

    pub fn clear(&mut self, attrs: crate::attrs::Attrs) {
        for cell in &mut self.cells {
            cell.clear(attrs);
        }
        self.wrapped = false;
        self.line_size = LineSize::Single;
    }

    fn cells(&self) -> impl Iterator<Item = &crate::Cell> {
        self.cells.iter()
    }

    pub fn get(&self, col: u16) -> Option<&crate::Cell> {
        self.cells.get(usize::from(col))
    }

    pub fn get_mut(&mut self, col: u16) -> Option<&mut crate::Cell> {
        self.cells.get_mut(usize::from(col))
    }

    pub fn insert(&mut self, i: u16, cell: crate::Cell) {
        self.cells.insert(usize::from(i), cell);
        self.wrapped = false;
    }

    pub fn remove(&mut self, i: u16) {
        self.clear_wide(i);
        self.cells.remove(usize::from(i));
        self.wrapped = false;
    }

    pub fn erase(&mut self, i: u16, attrs: crate::attrs::Attrs) {
        let wide = self.cells[usize::from(i)].is_wide();
        self.clear_wide(i);
        self.cells[usize::from(i)].clear(attrs);
        if i == self.cols().saturating_sub(if wide { 2 } else { 1 }) {
            self.wrapped = false;
        }
    }

    /// Cut the row to `len` cells. A wide character whose continuation half
    /// was cut off goes with it: left in the last column, it would claim a
    /// cell that no longer exists.
    pub fn truncate(&mut self, len: u16) {
        self.cells.truncate(usize::from(len));
        self.wrapped = false;
        if let Some(last_cell) = self.cells.last_mut() {
            if last_cell.is_wide() {
                last_cell.clear(*last_cell.attrs());
            }
        }
    }

    /// Drop the default cells at the end, keeping the row's flags. A row of
    /// scrollback then holds only what it shows; `resize` fills it back out
    /// when it returns to a screen.
    pub fn trim_blank_tail(&mut self) {
        let blank = crate::Cell::new();
        while self.cells.last() == Some(&blank) {
            self.cells.pop();
        }
        self.cells.shrink_to_fit();
    }

    pub fn resize(&mut self, len: u16, cell: crate::Cell) {
        if usize::from(len) < self.cells.len() {
            self.truncate(len);
        } else {
            self.cells.resize(usize::from(len), cell);
            self.wrapped = false;
        }
    }

    pub fn wrap(&mut self, wrap: bool) {
        self.wrapped = wrap;
    }

    pub fn wrapped(&self) -> bool {
        self.wrapped
    }

    /// Clear the other half of the wide character at `col`, if it has one.
    pub fn clear_wide(&mut self, col: u16) {
        let Some(cell) = self.get(col) else {
            return;
        };
        let other = if cell.is_wide() {
            col.checked_add(1)
        } else if cell.is_wide_continuation() {
            col.checked_sub(1)
        } else {
            None
        };
        if let Some(other) = other.and_then(|other| self.get_mut(other)) {
            other.clear(*other.attrs());
        }
    }

    pub fn write_contents(&self, contents: &mut String, start: u16, width: u16, wrapping: bool) {
        let mut prev_was_wide = false;

        let mut prev_col = start;
        for (col, cell) in self
            .cells()
            .enumerate()
            .skip(usize::from(start))
            .take(usize::from(width))
        {
            if prev_was_wide {
                prev_was_wide = false;
                continue;
            }
            prev_was_wide = cell.is_wide();

            // we limit the number of cols to a u16 (see Size)
            let col: u16 = col.try_into().unwrap();
            if cell.has_contents() {
                for _ in 0..(col - prev_col) {
                    contents.push(' ');
                }
                prev_col += col - prev_col;

                contents.push_str(cell.contents());
                prev_col += if cell.is_wide() { 2 } else { 1 };
            }
        }
        if prev_col == start && wrapping {
            contents.push('\n');
        }
    }
}

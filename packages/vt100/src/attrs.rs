
/// Represents a foreground or background color for cells.
#[derive(Eq, PartialEq, Debug, Copy, Clone, Default)]
pub enum Color {
    /// The default terminal color.
    #[default]
    Default,

    /// An indexed terminal color.
    Idx(u8),

    /// An RGB terminal color. The parameters are (red, green, blue).
    Rgb(u8, u8, u8),
}

const TEXT_MODE_INTENSITY: u8 = 0b0000_0011;
const TEXT_MODE_BOLD: u8 = 0b0000_0001;
const TEXT_MODE_DIM: u8 = 0b0000_0010;
const TEXT_MODE_ITALIC: u8 = 0b0000_0100;
const TEXT_MODE_UNDERLINE: u8 = 0b0000_1000;
const TEXT_MODE_INVERSE: u8 = 0b0001_0000;
const TEXT_MODE_SIZE: u8 = 0b0110_0000;
const TEXT_MODE_SIZE_DOUBLE_WIDTH: u8 = 0b0010_0000;
const TEXT_MODE_SIZE_DOUBLE_HEIGHT: u8 = 0b0100_0000;

/// The size a cell's text was drawn at with the kitty text sizing protocol
/// (`OSC 66`), as opposed to a whole row's DEC line size (`LineSize`).
#[derive(Copy, Clone, Debug, Default, Eq, PartialEq)]
pub enum TextSize {
    /// Drawn at the normal size.
    #[default]
    Normal,
    /// Twice as wide as normal, one row tall (`OSC 66 ; w=2`).
    DoubleWidth,
    /// Scaled to twice the size (`OSC 66 ; s=2`), so the text also covers
    /// the cell below its own.
    DoubleHeight,
}

/// Which entry of the screen's hyperlink table (`Hyperlinks`) a cell's text
/// was written under; 0 is none. Kept as bytes so a cell stays byte-aligned:
/// a `u32` would pad it to 40 bytes.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct LinkId([u8; 4]);

impl LinkId {
    pub const NONE: Self = Self([0; 4]);

    pub fn new(id: u32) -> Self {
        Self(id.to_ne_bytes())
    }

    pub fn get(self) -> Option<u32> {
        let id = u32::from_ne_bytes(self.0);
        (id != 0).then_some(id)
    }
}

#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Attrs {
    pub fgcolor: Color,
    pub bgcolor: Color,
    pub mode: u8,
    /// The hyperlink the text was written under. Only a drawn character (and
    /// the continuation half of a wide one) carries one: the screen's
    /// current SGR attributes never do, so an erase never paints a link.
    pub link: LinkId,
}

impl Attrs {
    pub fn bold(&self) -> bool {
        self.mode & TEXT_MODE_BOLD != 0
    }

    pub fn dim(&self) -> bool {
        self.mode & TEXT_MODE_DIM != 0
    }

    pub fn set_bold(&mut self) {
        self.mode &= !TEXT_MODE_INTENSITY;
        self.mode |= TEXT_MODE_BOLD;
    }

    pub fn set_dim(&mut self) {
        self.mode &= !TEXT_MODE_INTENSITY;
        self.mode |= TEXT_MODE_DIM;
    }

    pub fn set_normal_intensity(&mut self) {
        self.mode &= !TEXT_MODE_INTENSITY;
    }

    pub fn italic(&self) -> bool {
        self.mode & TEXT_MODE_ITALIC != 0
    }

    pub fn set_italic(&mut self, italic: bool) {
        if italic {
            self.mode |= TEXT_MODE_ITALIC;
        } else {
            self.mode &= !TEXT_MODE_ITALIC;
        }
    }

    pub fn underline(&self) -> bool {
        self.mode & TEXT_MODE_UNDERLINE != 0
    }

    pub fn set_underline(&mut self, underline: bool) {
        if underline {
            self.mode |= TEXT_MODE_UNDERLINE;
        } else {
            self.mode &= !TEXT_MODE_UNDERLINE;
        }
    }

    pub fn inverse(&self) -> bool {
        self.mode & TEXT_MODE_INVERSE != 0
    }

    pub fn set_inverse(&mut self, inverse: bool) {
        if inverse {
            self.mode |= TEXT_MODE_INVERSE;
        } else {
            self.mode &= !TEXT_MODE_INVERSE;
        }
    }

    pub fn text_size(&self) -> TextSize {
        match self.mode & TEXT_MODE_SIZE {
            TEXT_MODE_SIZE_DOUBLE_WIDTH => TextSize::DoubleWidth,
            TEXT_MODE_SIZE_DOUBLE_HEIGHT => TextSize::DoubleHeight,
            _ => TextSize::Normal,
        }
    }

    pub fn set_text_size(&mut self, size: TextSize) {
        self.mode &= !TEXT_MODE_SIZE;
        self.mode |= match size {
            TextSize::Normal => 0,
            TextSize::DoubleWidth => TEXT_MODE_SIZE_DOUBLE_WIDTH,
            TextSize::DoubleHeight => TEXT_MODE_SIZE_DOUBLE_HEIGHT,
        };
    }
}

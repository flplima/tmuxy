//! This crate parses a terminal byte stream and provides an in-memory
//! representation of the rendered contents.
//!
//! # Overview
//!
//! This is essentially the terminal parser component of a graphical terminal
//! emulator pulled out into a separate crate. Although you can use this crate
//! to build a graphical terminal emulator, it also contains functionality
//! necessary for implementing terminal applications that want to run other
//! terminal applications - programs like `screen` or `tmux` for example.
//!
//! # Synopsis
//!
//! ```
//! let mut parser = vt100::Parser::new(24, 80, 0);
//!
//! parser.process(b"this text is \x1b[31mRED\x1b[m");
//! assert_eq!(
//!     parser.screen().cell(0, 13).unwrap().fgcolor(),
//!     vt100::Color::Idx(1),
//! );
//!
//! parser.process(b"\x1b[3D\x1b[32mGREEN");
//! assert_eq!(parser.screen().contents(), "this text is GREEN");
//! ```
//!
//! This is tmuxy's fork (see PATCHES.md): it reads cells and never turns a
//! screen back into escape codes, so upstream's `*_formatted` and `*_diff`
//! serializers and the `term` module behind them are not here.

#![warn(missing_docs)]
#![warn(clippy::cargo)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]
#![warn(clippy::as_conversions)]
#![warn(clippy::get_unwrap)]
#![allow(clippy::cognitive_complexity)]
#![allow(clippy::missing_const_for_fn)]
#![allow(clippy::similar_names)]
#![allow(clippy::struct_excessive_bools)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::too_many_lines)]
#![allow(clippy::type_complexity)]

mod attrs;
mod callbacks;
mod cell;
mod grid;
mod parser;
mod perform;
mod row;
mod screen;

pub use attrs::Color;
pub use callbacks::Callbacks;
pub use cell::Cell;
pub use parser::Parser;
pub use row::LineSize;
pub use screen::{MouseProtocolEncoding, MouseProtocolMode, Screen, Scrollback};

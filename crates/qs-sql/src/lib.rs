//! SQL handling for Quicksilver.
//!
//! Splits a buffer into statements today. Generating the SQL Quicksilver
//! writes for the user (cell edits, sorts, filters) and the parse-tree gates
//! that check it arrive in phases 5 and 6.

pub mod split;

pub use split::{Dialect, Statement, split, statement_at};

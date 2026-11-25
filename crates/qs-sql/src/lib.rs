//! SQL handling for Quicksilver: splitting a buffer into statements,
//! classifying what each does, generating the statements Quicksilver writes
//! for the user (cell edits, inserts, deletes) and the parse-tree gates that
//! check them before anything runs.

pub mod classify;
pub mod edit;
pub mod gate;
pub mod split;

pub use classify::{Classified, StatementKind, classify};
pub use split::{Dialect, Statement, split, statement_at};

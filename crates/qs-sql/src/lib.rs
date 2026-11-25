//! SQL handling for Quicksilver.
//!
//! Splits a buffer into statements, generates the SQL Quicksilver writes for
//! the user (cell edits, sorts, filters) and checks every generated statement
//! against a parse-tree whitelist before it can run. Filled in from phase 5.

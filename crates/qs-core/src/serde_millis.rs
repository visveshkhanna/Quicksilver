//! Durations cross to the UI as milliseconds, a plain number JavaScript can
//! use directly, rather than serde's `{ secs, nanos }`.

use std::time::Duration;

use serde::Serializer;

/// Serializes a duration as fractional milliseconds. Use with
/// `#[serde(serialize_with = "qs_core::serde_millis::serialize")]`.
pub fn serialize<S: Serializer>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_f64(duration.as_secs_f64() * 1000.0)
}

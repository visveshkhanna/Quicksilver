//! How a result's columns are described to everything above the drivers.
//!
//! Cells themselves are rendered strings (or NULL); a column's [`TypeTag`]
//! says how to align, format and edit them. Nothing here carries a driver
//! type.

use serde::{Deserialize, Serialize};

/// The broad kind of a column, enough for the grid to align, format and
/// choose an editor. The exact server type is kept in [`Column::db_type`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TypeTag {
    /// true / false.
    Bool,
    /// A whole number of any width.
    Integer,
    /// A binary floating-point number.
    Float,
    /// An exact decimal; never parsed into a float.
    Decimal,
    /// Text of any length.
    Text,
    /// Binary data, rendered as `\x` followed by hex.
    Bytes,
    /// A calendar date.
    Date,
    /// A time of day, with or without a zone.
    Time,
    /// A date and time without a zone.
    Timestamp,
    /// A date and time with a zone or offset.
    TimestampTz,
    /// A duration.
    Interval,
    /// A UUID.
    Uuid,
    /// JSON or JSONB.
    Json,
    /// An array of any element type.
    Array,
    /// An IP address, network or MAC address.
    Network,
    /// Anything else, shown as the server rendered it.
    Other,
}

impl TypeTag {
    /// Whether the grid right-aligns this kind of value.
    pub fn is_numeric(self) -> bool {
        matches!(self, TypeTag::Integer | TypeTag::Float | TypeTag::Decimal)
    }
}

/// Where a result column's values come from, when the server says so. Phase 6
/// uses it to decide whether a cell can be edited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnSource {
    /// A Postgres table column, by table OID and attribute number.
    PostgresAttribute {
        /// `pg_class.oid` of the table.
        table_oid: u32,
        /// `pg_attribute.attnum` of the column.
        column_id: i16,
    },
    /// A table column named by its database, table and column.
    Named {
        /// The schema or attached database (`main` on SQLite).
        schema: Option<String>,
        /// The table.
        table: String,
        /// The column in that table.
        column: String,
    },
}

/// One column of a result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    /// The name the server gave the column. Several columns may share one.
    pub name: String,
    /// The broad kind of the values.
    pub type_tag: TypeTag,
    /// The server's own name for the type, such as `int8`, `text[]` or
    /// `VARCHAR(20)`. Empty when the server does not say.
    pub db_type: String,
    /// The table column the values come from, when known.
    pub source: Option<ColumnSource>,
}

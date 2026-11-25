//! Where result rows live while the UI looks at them.
//!
//! Rows are stored column by column in chunks: per column, one byte buffer
//! holding every cell's text back to back, the end offset of each cell, and a
//! NULL bitmap. A million rows of ten short columns take a few tens of
//! megabytes this way, against hundreds as one `String` per cell.
//!
//! Readers fetch any window of rows while the driver is still appending; the
//! UI never holds more than the page it is drawing.

use std::sync::RwLock;

use qs_core::{Column, Error, Result};
use qs_drivers::RowView;

/// Rows per chunk. Large enough that per-chunk overhead vanishes, small enough
/// that a chunk's offsets fit comfortably in `u32`.
const CHUNK_ROWS: usize = 64 * 1024;

/// The marker a page uses for a NULL cell's length.
pub const NULL_LENGTH: u32 = u32::MAX;

/// The first four bytes of every page.
pub const PAGE_MAGIC: &[u8; 4] = b"QSP1";

/// One statement's rows.
pub struct ResultStore {
    columns: Vec<Column>,
    data: RwLock<Data>,
}

#[derive(Default)]
struct Data {
    chunks: Vec<Chunk>,
    /// The row number each chunk starts at, for binary search.
    starts: Vec<u64>,
    rows: u64,
    bytes: u64,
}

struct Chunk {
    rows: usize,
    columns: Vec<ColumnChunk>,
}

#[derive(Default)]
struct ColumnChunk {
    text: Vec<u8>,
    ends: Vec<u32>,
    nulls: Vec<u64>,
}

impl ColumnChunk {
    fn is_null(&self, row: usize) -> bool {
        self.nulls
            .get(row / 64)
            .is_some_and(|word| word & (1 << (row % 64)) != 0)
    }

    fn cell(&self, row: usize) -> Option<&[u8]> {
        if self.is_null(row) {
            return None;
        }
        let start = if row == 0 {
            0
        } else {
            self.ends[row - 1] as usize
        };
        Some(&self.text[start..self.ends[row] as usize])
    }

    fn bytes(&self) -> u64 {
        (self.text.capacity() + self.ends.capacity() * 4 + self.nulls.capacity() * 8) as u64
    }
}

impl Chunk {
    fn new(width: usize) -> Self {
        Chunk {
            rows: 0,
            columns: (0..width).map(|_| ColumnChunk::default()).collect(),
        }
    }

    /// Whether `row` fits without any column's offsets passing `u32::MAX`.
    fn fits(&self, row: &dyn RowView) -> bool {
        self.rows < CHUNK_ROWS
            && self.columns.iter().enumerate().all(|(i, column)| {
                let len = row.get(i).map_or(0, str::len);
                column.text.len().saturating_add(len) <= u32::MAX as usize
            })
    }
}

impl ResultStore {
    /// An empty store for rows with these columns.
    pub fn new(columns: Vec<Column>) -> Self {
        ResultStore {
            columns,
            data: RwLock::new(Data::default()),
        }
    }

    /// The columns every row has.
    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// Rows stored so far.
    pub fn row_count(&self) -> u64 {
        self.read().map(|d| d.rows).unwrap_or(0)
    }

    /// Approximate memory held, in bytes.
    pub fn bytes(&self) -> u64 {
        self.read().map(|d| d.bytes).unwrap_or(0)
    }

    fn read(&self) -> Result<std::sync::RwLockReadGuard<'_, Data>> {
        self.data
            .read()
            .map_err(|_| Error::internal("a result store was poisoned by an earlier panic"))
    }

    /// Appends one row. Cells beyond the column count are ignored and missing
    /// ones stored as NULL, so a misbehaving driver cannot shift columns.
    pub fn push(&self, row: &dyn RowView) -> Result<()> {
        let width = self.columns.len();
        let mut data = self
            .data
            .write()
            .map_err(|_| Error::internal("a result store was poisoned by an earlier panic"))?;
        if data.chunks.last().is_none_or(|chunk| !chunk.fits(row)) {
            let fresh = Chunk::new(width);
            if !fresh.fits(row) {
                return Err(Error::unsupported(
                    "a single row holds a value larger than 4 GB",
                ));
            }
            let start = data.rows;
            data.chunks.push(fresh);
            data.starts.push(start);
        }
        let Data {
            chunks,
            rows,
            bytes,
            ..
        } = &mut *data;
        let chunk = chunks.last_mut().expect("a chunk was just ensured");
        let index = chunk.rows;
        let mut added = 0u64;
        for (i, column) in chunk.columns.iter_mut().enumerate() {
            let before = column.bytes();
            match row.get(i) {
                Some(text) => column.text.extend_from_slice(text.as_bytes()),
                None => {
                    if column.nulls.len() <= index / 64 {
                        column.nulls.resize(index / 64 + 1, 0);
                    }
                    column.nulls[index / 64] |= 1 << (index % 64);
                }
            }
            // The length was checked by `fits`.
            column.ends.push(column.text.len() as u32);
            added += column.bytes() - before;
        }
        chunk.rows += 1;
        *rows += 1;
        *bytes += added;
        Ok(())
    }

    /// Encodes rows `offset .. offset + count` (clamped to what exists) as a
    /// page:
    ///
    /// ```text
    /// "QSP1"                   4 bytes
    /// row count     u32 LE     rows in this page
    /// column count  u32 LE
    /// first row     u64 LE     the offset asked for
    /// cells, row by row: length u32 LE (0xFFFFFFFF for NULL), then UTF-8 bytes
    /// ```
    pub fn page(&self, offset: u64, count: u32) -> Result<Vec<u8>> {
        let data = self.read()?;
        let end = offset.saturating_add(u64::from(count)).min(data.rows);
        let rows = end.saturating_sub(offset);
        let width = self.columns.len();

        let mut out = Vec::with_capacity(20 + rows as usize * width * 12);
        out.extend_from_slice(PAGE_MAGIC);
        out.extend_from_slice(&(rows as u32).to_le_bytes());
        out.extend_from_slice(&(width as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());

        // Chunks usually hold CHUNK_ROWS rows, but a huge row can close one
        // early, so find the first by its recorded start rather than by
        // division.
        let mut index = data
            .starts
            .partition_point(|&start| start <= offset)
            .saturating_sub(1);
        for row in offset..end {
            while row >= data.starts[index] + data.chunks[index].rows as u64 {
                index += 1;
            }
            let local = (row - data.starts[index]) as usize;
            for column in &data.chunks[index].columns {
                match column.cell(local) {
                    None => out.extend_from_slice(&NULL_LENGTH.to_le_bytes()),
                    Some(bytes) => {
                        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                        out.extend_from_slice(bytes);
                    }
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use qs_core::TypeTag;

    struct Row(Vec<Option<&'static str>>);

    impl RowView for Row {
        fn len(&self) -> usize {
            self.0.len()
        }
        fn get(&self, index: usize) -> Option<&str> {
            self.0.get(index).copied().flatten()
        }
    }

    fn store(width: usize) -> ResultStore {
        let columns = (0..width)
            .map(|i| Column {
                name: format!("c{i}"),
                type_tag: TypeTag::Text,
                db_type: "text".into(),
                source: None,
            })
            .collect();
        ResultStore::new(columns)
    }

    /// Decodes a page back into rows, the way the UI does.
    fn decode(page: &[u8]) -> (u64, Vec<Vec<Option<String>>>) {
        assert_eq!(&page[..4], PAGE_MAGIC);
        let u32_at = |at: usize| u32::from_le_bytes(page[at..at + 4].try_into().expect("4 bytes"));
        let rows = u32_at(4) as usize;
        let width = u32_at(8) as usize;
        let first = u64::from_le_bytes(page[12..20].try_into().expect("8 bytes"));
        let mut at = 20;
        let mut out = Vec::new();
        for _ in 0..rows {
            let mut row = Vec::new();
            for _ in 0..width {
                let len = u32_at(at);
                at += 4;
                if len == NULL_LENGTH {
                    row.push(None);
                } else {
                    row.push(Some(
                        String::from_utf8(page[at..at + len as usize].to_vec()).expect("utf8"),
                    ));
                    at += len as usize;
                }
            }
            out.push(row);
        }
        assert_eq!(at, page.len(), "no trailing bytes");
        (first, out)
    }

    #[test]
    fn a_page_has_the_documented_layout() {
        let s = store(2);
        s.push(&Row(vec![Some("ab"), None])).expect("push");
        let page = s.page(0, 10).expect("page");
        let expected: Vec<u8> = [
            b"QSP1".as_slice(),
            &1u32.to_le_bytes(),
            &2u32.to_le_bytes(),
            &0u64.to_le_bytes(),
            &2u32.to_le_bytes(),
            b"ab",
            &u32::MAX.to_le_bytes(),
        ]
        .concat();
        assert_eq!(page, expected);
    }

    #[test]
    fn round_trips_nulls_empty_strings_and_unicode() {
        let s = store(3);
        s.push(&Row(vec![Some(""), None, Some("🚀 é")]))
            .expect("push");
        s.push(&Row(vec![None, Some("x"), None])).expect("push");
        let (first, rows) = decode(&s.page(0, 2).expect("page"));
        assert_eq!(first, 0);
        assert_eq!(
            rows,
            vec![
                vec![Some(String::new()), None, Some("🚀 é".into())],
                vec![None, Some("x".into()), None]
            ]
        );
    }

    #[test]
    fn pages_across_chunk_boundaries_and_clamps_past_the_end() {
        let s = store(1);
        let total = CHUNK_ROWS * 2 + 10;
        let values: Vec<String> = (0..total).map(|i| i.to_string()).collect();
        for value in &values {
            let leaked: &'static str = Box::leak(value.clone().into_boxed_str());
            s.push(&Row(vec![Some(leaked)])).expect("push");
        }
        assert_eq!(s.row_count(), total as u64);

        let around = CHUNK_ROWS as u64 - 2;
        let (first, rows) = decode(&s.page(around, 5).expect("page"));
        assert_eq!(first, around);
        let got: Vec<_> = rows
            .iter()
            .map(|r| r[0].clone().expect("not null"))
            .collect();
        let want: Vec<_> = (around..around + 5).map(|i| i.to_string()).collect();
        assert_eq!(got, want);

        let (_, tail) = decode(&s.page(total as u64 - 3, 100).expect("page"));
        assert_eq!(tail.len(), 3);
        let (_, none) = decode(&s.page(total as u64 + 5, 100).expect("page"));
        assert!(none.is_empty());
    }

    #[test]
    fn short_rows_store_missing_cells_as_null() {
        let s = store(3);
        s.push(&Row(vec![Some("only")])).expect("push");
        let (_, rows) = decode(&s.page(0, 1).expect("page"));
        assert_eq!(rows[0], vec![Some("only".into()), None, None]);
    }

    #[test]
    fn counts_its_memory() {
        let s = store(2);
        assert_eq!(s.bytes(), 0);
        s.push(&Row(vec![Some("hello"), Some("world")]))
            .expect("push");
        assert!(s.bytes() >= 10);
    }
}

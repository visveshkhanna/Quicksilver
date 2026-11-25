//! Where result rows live while the UI looks at them.
//!
//! Rows are stored column by column in chunks: per column, one byte buffer
//! holding every cell's text back to back, the end offset of each cell, and a
//! NULL bitmap. A million rows of ten short columns take a few tens of
//! megabytes this way, against hundreds as one `String` per cell.
//!
//! Once a result holds more cell text than its [`SpillPolicy`] allows, each
//! chunk that fills up has its text written to an unnamed temporary file and
//! dropped from memory. Only the offsets and NULL bitmaps stay, about five
//! bytes per cell, so memory stays bounded however many rows arrive. The
//! operating system deletes the file when the result is closed, or if the app
//! dies.
//!
//! Readers fetch any window of rows while the driver is still appending; the
//! UI never holds more than the page it is drawing. A finished result can be
//! sorted, which reorders what pages return without moving any rows.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, RwLock, RwLockReadGuard};

use qs_core::{Column, Error, Result, TypeTag};
use qs_drivers::RowView;

/// Rows per chunk. Large enough that per-chunk overhead vanishes, small enough
/// that a chunk's offsets fit comfortably in `u32`.
const CHUNK_ROWS: usize = 64 * 1024;

/// Cell text per chunk before a new one starts, so a spilled chunk is
/// written, and read back, in pieces of a sensible size.
const CHUNK_TEXT_BYTES: usize = 16 * 1024 * 1024;

/// The marker a page uses for a NULL cell's length.
pub const NULL_LENGTH: u32 = u32::MAX;

/// The first four bytes of every page.
pub const PAGE_MAGIC: &[u8; 4] = b"QSP2";

/// When a result's rows move from memory to a temporary file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpillPolicy {
    /// Cell text a result may hold in memory before full chunks are written
    /// out. `None` never spills.
    pub threshold: Option<u64>,
    /// Where the temporary file goes; the system temporary directory if
    /// `None`.
    pub dir: Option<PathBuf>,
}

impl Default for SpillPolicy {
    fn default() -> Self {
        SpillPolicy {
            threshold: Some(64 * 1024 * 1024),
            dir: None,
        }
    }
}

/// Which way a sort goes. NULLs sort last going up and first going down, as
/// in PostgreSQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    /// Smallest first.
    Ascending,
    /// Largest first.
    Descending,
}

/// One statement's rows.
pub struct ResultStore {
    columns: Vec<Column>,
    policy: SpillPolicy,
    data: RwLock<Data>,
}

#[derive(Default)]
struct Data {
    chunks: Vec<Chunk>,
    /// The row number each chunk starts at, for binary search.
    starts: Vec<u64>,
    rows: u64,
    /// Memory held, in bytes.
    bytes: u64,
    /// Cell text held in memory, in bytes; what the spill threshold counts.
    text_in_memory: u64,
    /// Cell text written to the spill file, in bytes.
    spilled: u64,
    file: Option<Arc<File>>,
    /// Whether the statement has finished, so no more rows can arrive.
    finished: bool,
    /// The row each displayed position shows, when sorted.
    order: Option<Arc<Vec<u32>>>,
}

struct Chunk {
    rows: usize,
    text_bytes: usize,
    columns: Vec<ColumnChunk>,
}

/// Where a column chunk's text is.
enum Text {
    Memory(Vec<u8>),
    /// At `offset` in the spill file, `len` bytes long.
    Spilled {
        offset: u64,
        len: usize,
    },
}

struct ColumnChunk {
    text: Text,
    ends: Vec<u32>,
    nulls: Vec<u64>,
}

impl ColumnChunk {
    fn new() -> Self {
        ColumnChunk {
            text: Text::Memory(Vec::new()),
            ends: Vec::new(),
            nulls: Vec::new(),
        }
    }

    fn is_null(&self, row: usize) -> bool {
        self.nulls
            .get(row / 64)
            .is_some_and(|word| word & (1 << (row % 64)) != 0)
    }

    fn start(&self, row: usize) -> usize {
        if row == 0 {
            0
        } else {
            self.ends[row - 1] as usize
        }
    }

    fn text_len(&self) -> usize {
        match &self.text {
            Text::Memory(text) => text.len(),
            Text::Spilled { len, .. } => *len,
        }
    }

    fn bytes(&self) -> u64 {
        let text = match &self.text {
            Text::Memory(text) => text.capacity(),
            Text::Spilled { .. } => 0,
        };
        (text + self.ends.capacity() * 4 + self.nulls.capacity() * 8) as u64
    }

    /// The text of rows `from .. to`, back to back; cell `r` is at
    /// `start(r) - start(from) .. ends[r] - start(from)`.
    fn text_range(&self, file: Option<&File>, from: usize, to: usize) -> Result<Cow<'_, [u8]>> {
        if from >= to {
            return Ok(Cow::Borrowed(&[]));
        }
        let (start, end) = (self.start(from), self.ends[to - 1] as usize);
        match &self.text {
            Text::Memory(text) => Ok(Cow::Borrowed(&text[start..end])),
            Text::Spilled { offset, .. } => {
                let file = file.ok_or_else(|| Error::internal("a spilled result lost its file"))?;
                let mut buf = vec![0; end - start];
                read_at(file, &mut buf, offset + start as u64)?;
                Ok(Cow::Owned(buf))
            }
        }
    }
}

impl Chunk {
    fn new(width: usize) -> Self {
        Chunk {
            rows: 0,
            text_bytes: 0,
            columns: (0..width).map(|_| ColumnChunk::new()).collect(),
        }
    }

    fn row_text(row: &dyn RowView, width: usize) -> usize {
        (0..width).map(|i| row.get(i).map_or(0, str::len)).sum()
    }

    /// Whether `row` belongs in this chunk: it has room, and no column's
    /// offsets would pass `u32::MAX`. An empty chunk takes any row that fits
    /// the offsets, however large.
    fn fits(&self, row: &dyn RowView) -> bool {
        let width = self.columns.len();
        let roomy = self.rows == 0
            || (self.rows < CHUNK_ROWS
                && self.text_bytes + Self::row_text(row, width) <= CHUNK_TEXT_BYTES);
        roomy
            && self.columns.iter().enumerate().all(|(i, column)| {
                let len = row.get(i).map_or(0, str::len);
                column.text_len().saturating_add(len) <= u32::MAX as usize
            })
    }
}

#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(buf, offset)
        .map_err(|err| Error::internal(format!("reading spilled rows failed: {err}")))
}

#[cfg(windows)]
fn read_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_read(buf, offset) {
            Ok(0) => return Err(Error::internal("spilled rows ended early")),
            Ok(n) => {
                buf = &mut buf[n..];
                offset += n as u64;
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) => {
                return Err(Error::internal(format!(
                    "reading spilled rows failed: {err}"
                )));
            }
        }
    }
    Ok(())
}

fn poisoned() -> Error {
    Error::internal("a result store was poisoned by an earlier panic")
}

/// Cells of one result row, borrowed for the length of a callback.
pub struct Cells<'a> {
    cells: &'a [Option<&'a str>],
}

impl Cells<'_> {
    /// The cell in output column `index` (an index into the `columns` asked
    /// for), or `None` for NULL.
    pub fn get(&self, index: usize) -> Option<&str> {
        self.cells.get(index).copied().flatten()
    }

    /// How many cells the row has.
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    /// Whether the row has no cells.
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
}

impl ResultStore {
    /// An empty store for rows with these columns, kept in memory.
    pub fn new(columns: Vec<Column>) -> Self {
        Self::with_policy(
            columns,
            SpillPolicy {
                threshold: None,
                dir: None,
            },
        )
    }

    /// An empty store that spills to disk by `policy`.
    pub fn with_policy(columns: Vec<Column>, policy: SpillPolicy) -> Self {
        ResultStore {
            columns,
            policy,
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

    /// Cell text written to disk, in bytes.
    pub fn spilled_bytes(&self) -> u64 {
        self.read().map(|d| d.spilled).unwrap_or(0)
    }

    /// The current sort, if any.
    pub fn is_sorted(&self) -> bool {
        self.read().is_ok_and(|d| d.order.is_some())
    }

    fn read(&self) -> Result<RwLockReadGuard<'_, Data>> {
        self.data.read().map_err(|_| poisoned())
    }

    /// Appends one row. Cells beyond the column count are ignored and missing
    /// ones stored as NULL, so a misbehaving driver cannot shift columns.
    pub fn push(&self, row: &dyn RowView) -> Result<()> {
        let width = self.columns.len();
        let mut data = self.data.write().map_err(|_| poisoned())?;
        if data.finished {
            return Err(Error::internal("rows arrived after the result finished"));
        }
        if data.chunks.last().is_none_or(|chunk| !chunk.fits(row)) {
            let fresh = Chunk::new(width);
            if !fresh.fits(row) {
                return Err(Error::unsupported(
                    "a single row holds a value larger than 4 GB",
                ));
            }
            self.maybe_spill(&mut data)?;
            let start = data.rows;
            data.chunks.push(fresh);
            data.starts.push(start);
        }
        let Data {
            chunks,
            rows,
            bytes,
            text_in_memory,
            ..
        } = &mut *data;
        let chunk = chunks.last_mut().expect("a chunk was just ensured");
        let index = chunk.rows;
        let mut added = 0u64;
        for (i, column) in chunk.columns.iter_mut().enumerate() {
            let before = column.bytes();
            let Text::Memory(text) = &mut column.text else {
                return Err(Error::internal("the open chunk was spilled"));
            };
            match row.get(i) {
                Some(cell) => {
                    text.extend_from_slice(cell.as_bytes());
                    chunk.text_bytes += cell.len();
                    *text_in_memory += cell.len() as u64;
                }
                None => {
                    if column.nulls.len() <= index / 64 {
                        column.nulls.resize(index / 64 + 1, 0);
                    }
                    column.nulls[index / 64] |= 1 << (index % 64);
                }
            }
            // The length was checked by `fits`.
            column.ends.push(text.len() as u32);
            added += column.bytes() - before;
        }
        chunk.rows += 1;
        *rows += 1;
        *bytes += added;
        Ok(())
    }

    /// Writes every full chunk's text to the spill file while the result
    /// holds more text in memory than the policy allows. The open chunk is
    /// never spilled; the caller is about to start a new one.
    fn maybe_spill(&self, data: &mut Data) -> Result<()> {
        let Some(threshold) = self.policy.threshold else {
            return Ok(());
        };
        if data.text_in_memory <= threshold {
            return Ok(());
        }
        if data.file.is_none() {
            let file = match &self.policy.dir {
                Some(dir) => tempfile::tempfile_in(dir),
                None => tempfile::tempfile(),
            }
            .map_err(|err| Error::internal(format!("cannot create a spill file: {err}")))?;
            data.file = Some(Arc::new(file));
        }
        let file = Arc::clone(data.file.as_ref().expect("just ensured"));
        let mut writer = std::io::BufWriter::with_capacity(1 << 20, &*file);
        for chunk in &mut data.chunks {
            for column in &mut chunk.columns {
                let Text::Memory(text) = &column.text else {
                    continue;
                };
                writer.write_all(text).map_err(|err| {
                    Error::internal(format!("writing spilled rows failed: {err}"))
                })?;
                let before = column.bytes();
                let len = text.len();
                column.text = Text::Spilled {
                    offset: data.spilled,
                    len,
                };
                data.spilled += len as u64;
                data.text_in_memory -= len as u64;
                data.bytes -= before - column.bytes();
            }
        }
        writer
            .flush()
            .map_err(|err| Error::internal(format!("writing spilled rows failed: {err}")))?;
        Ok(())
    }

    /// Marks the result complete: no more rows will arrive, and it can be
    /// sorted.
    pub fn finish(&self) {
        if let Ok(mut data) = self.data.write() {
            data.finished = true;
        }
    }

    /// Sorts the rows pages return by `column`, or restores the order they
    /// arrived in with `None`. Only a finished result can be sorted.
    ///
    /// Numbers sort as numbers and booleans false first; everything else
    /// sorts by its text, which orders ISO dates and times correctly. The
    /// sort is stable, so sorting by one column and then another orders by
    /// both.
    pub fn sort(&self, by: Option<(usize, SortDirection)>) -> Result<()> {
        let Some((column, direction)) = by else {
            self.data.write().map_err(|_| poisoned())?.order = None;
            return Ok(());
        };
        let tag = self
            .columns
            .get(column)
            .ok_or_else(|| Error::config(format!("no column {column}")))?
            .type_tag;
        let (rows, previous) = {
            let data = self.read()?;
            if !data.finished {
                return Err(Error::config("a result can be sorted once it has finished"));
            }
            if data.rows > u64::from(u32::MAX) {
                return Err(Error::unsupported("results this large cannot be sorted"));
            }
            (data.rows as usize, data.order.clone())
        };

        let mut keys: Vec<Key> = Vec::with_capacity(rows);
        self.for_each_cell(column, |cell| keys.push(Key::of(tag, cell)))?;
        // Stable on top of the current order, so sorts compose.
        let mut order: Vec<u32> = match previous {
            Some(order) => order.as_ref().clone(),
            None => (0..rows as u32).collect(),
        };
        order.sort_by(|&a, &b| {
            let (a, b) = (&keys[a as usize], &keys[b as usize]);
            match (a, b) {
                (Key::Null, Key::Null) => Ordering::Equal,
                (Key::Null, _) => match direction {
                    SortDirection::Ascending => Ordering::Greater,
                    SortDirection::Descending => Ordering::Less,
                },
                (_, Key::Null) => match direction {
                    SortDirection::Ascending => Ordering::Less,
                    SortDirection::Descending => Ordering::Greater,
                },
                _ => match direction {
                    SortDirection::Ascending => a.cmp(b),
                    SortDirection::Descending => b.cmp(a),
                },
            }
        });
        self.data.write().map_err(|_| poisoned())?.order = Some(Arc::new(order));
        Ok(())
    }

    /// Calls `f` with every cell of `column`, in arrival order.
    fn for_each_cell(&self, column: usize, mut f: impl FnMut(Option<&[u8]>)) -> Result<()> {
        let data = self.read()?;
        let file = data.file.as_deref();
        for chunk in &data.chunks {
            let col = &chunk.columns[column];
            let text = col.text_range(file, 0, chunk.rows)?;
            for row in 0..chunk.rows {
                if col.is_null(row) {
                    f(None);
                } else {
                    f(Some(&text[col.start(row)..col.ends[row] as usize]));
                }
            }
        }
        Ok(())
    }

    /// Calls `f` with displayed rows `offset .. offset + count` (clamped to
    /// what exists), in the current sort order, each holding the cells of
    /// `columns` in that order.
    pub fn rows(
        &self,
        offset: u64,
        count: u64,
        columns: &[usize],
        mut f: impl FnMut(Cells<'_>),
    ) -> Result<()> {
        if let Some(&bad) = columns.iter().find(|&&c| c >= self.columns.len()) {
            return Err(Error::config(format!("no column {bad}")));
        }
        self.visit(offset, count, columns, |_, row| {
            let cells: Vec<Option<&str>> = row
                .iter()
                .map(|cell| {
                    // Stored text always came from a `&str`.
                    cell.map(|bytes| std::str::from_utf8(bytes).unwrap_or("\u{FFFD}"))
                })
                .collect();
            f(Cells { cells: &cells });
        })
    }

    /// The cells of source row `row` (its place in arrival order), as text.
    pub fn source_row(&self, row: u64) -> Result<Vec<Option<String>>> {
        let data = self.read()?;
        if row >= data.rows {
            return Err(Error::config(format!("no row {row}")));
        }
        let index = data.starts.partition_point(|&start| start <= row) - 1;
        let chunk = &data.chunks[index];
        let local = (row - data.starts[index]) as usize;
        let file = data.file.as_deref();
        chunk
            .columns
            .iter()
            .map(|column| {
                if column.is_null(local) {
                    return Ok(None);
                }
                let text = column.text_range(file, local, local + 1)?;
                Ok(Some(String::from_utf8_lossy(&text).into_owned()))
            })
            .collect()
    }

    /// Calls `f` with the source row number and raw cells of displayed rows
    /// `offset .. offset + count`, restricted to `columns`.
    fn visit(
        &self,
        offset: u64,
        count: u64,
        columns: &[usize],
        mut f: impl FnMut(u64, &[Option<&[u8]>]),
    ) -> Result<()> {
        let data = self.read()?;
        let end = offset.saturating_add(count).min(data.rows);
        if offset >= end {
            return Ok(());
        }
        let file = data.file.as_deref();
        match &data.order {
            None => {
                // Chunks usually hold CHUNK_ROWS rows, but size limits close
                // some early, so find the first by its recorded start.
                let mut index = data
                    .starts
                    .partition_point(|&start| start <= offset)
                    .saturating_sub(1);
                let mut at = offset;
                while at < end {
                    let chunk = &data.chunks[index];
                    let base = data.starts[index];
                    let from = (at - base) as usize;
                    let to = ((end - base) as usize).min(chunk.rows);
                    // One read per column for the whole run of rows.
                    let texts = columns
                        .iter()
                        .map(|&c| chunk.columns[c].text_range(file, from, to))
                        .collect::<Result<Vec<_>>>()?;
                    let mut row: Vec<Option<&[u8]>> = Vec::with_capacity(columns.len());
                    for local in from..to {
                        row.clear();
                        for (text, &c) in texts.iter().zip(columns) {
                            let col = &chunk.columns[c];
                            row.push(if col.is_null(local) {
                                None
                            } else {
                                let shift = col.start(from);
                                Some(
                                    &text[col.start(local) - shift
                                        ..col.ends[local] as usize - shift],
                                )
                            });
                        }
                        f(base + local as u64, &row);
                    }
                    at = base + to as u64;
                    index += 1;
                }
            }
            Some(order) => {
                for &source in &order[offset as usize..end as usize] {
                    let source = u64::from(source);
                    let index = data.starts.partition_point(|&start| start <= source) - 1;
                    let chunk = &data.chunks[index];
                    let local = (source - data.starts[index]) as usize;
                    let texts = columns
                        .iter()
                        .map(|&c| chunk.columns[c].text_range(file, local, local + 1))
                        .collect::<Result<Vec<Cow<'_, [u8]>>>>()?;
                    let row: Vec<Option<&[u8]>> = texts
                        .iter()
                        .zip(columns)
                        .map(|(text, &c)| (!chunk.columns[c].is_null(local)).then_some(&text[..]))
                        .collect();
                    f(source, &row);
                }
            }
        }
        Ok(())
    }

    /// Encodes displayed rows `offset .. offset + count` (clamped to what
    /// exists) as a page:
    ///
    /// ```text
    /// "QSP2"                   4 bytes
    /// row count     u32 LE     rows in this page
    /// column count  u32 LE
    /// first row     u64 LE     the offset asked for
    /// then, row by row:
    ///   source row  u64 LE     the row's place in arrival order, which
    ///                          edits name it by whatever the sort
    ///   cells: length u32 LE (0xFFFFFFFF for NULL), then UTF-8 bytes
    /// ```
    pub fn page(&self, offset: u64, count: u32) -> Result<Vec<u8>> {
        let width = self.columns.len();
        let all: Vec<usize> = (0..width).collect();
        let mut out = Vec::with_capacity(20 + count.min(1024) as usize * width * 12);
        out.extend_from_slice(PAGE_MAGIC);
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(width as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        let mut rows = 0u32;
        self.visit(offset, u64::from(count), &all, |source, row| {
            rows += 1;
            out.extend_from_slice(&source.to_le_bytes());
            for cell in row {
                match cell {
                    None => out.extend_from_slice(&NULL_LENGTH.to_le_bytes()),
                    Some(bytes) => {
                        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                        out.extend_from_slice(bytes);
                    }
                }
            }
        })?;
        out[4..8].copy_from_slice(&rows.to_le_bytes());
        Ok(out)
    }
}

/// A cell's sort key.
enum Key {
    Null,
    Int(i128),
    Float(f64),
    Text(Vec<u8>),
}

impl PartialEq for Key {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Key {}

impl PartialOrd for Key {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Key {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Key::Int(a), Key::Int(b)) => a.cmp(b),
            (Key::Float(a), Key::Float(b)) => a.total_cmp(b),
            (Key::Int(a), Key::Float(b)) => (*a as f64).total_cmp(b),
            (Key::Float(a), Key::Int(b)) => a.total_cmp(&(*b as f64)),
            (Key::Text(a), Key::Text(b)) => a.cmp(b),
            // Numbers before text in a column that mixes them (SQLite).
            (Key::Text(_), _) => Ordering::Greater,
            (_, Key::Text(_)) => Ordering::Less,
            (Key::Null, Key::Null) => Ordering::Equal,
            (Key::Null, _) => Ordering::Greater,
            (_, Key::Null) => Ordering::Less,
        }
    }
}

impl Key {
    fn of(tag: TypeTag, cell: Option<&[u8]>) -> Key {
        let Some(bytes) = cell else {
            return Key::Null;
        };
        let text = std::str::from_utf8(bytes).unwrap_or_default();
        let number = || {
            text.parse::<i128>()
                .map(Key::Int)
                .or_else(|_| text.parse::<f64>().map(Key::Float))
                .ok()
        };
        let key = match tag {
            TypeTag::Integer | TypeTag::Float | TypeTag::Decimal => number(),
            TypeTag::Bool => match text {
                "t" | "true" | "1" | "TRUE" => Some(Key::Int(1)),
                "f" | "false" | "0" | "FALSE" => Some(Key::Int(0)),
                _ => None,
            },
            // SQLite columns without a declared type hold whatever was put
            // in them; numbers among them still sort as numbers.
            TypeTag::Other => number(),
            _ => None,
        };
        key.unwrap_or_else(|| Key::Text(bytes.to_vec()))
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
            at += 8;
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
            b"QSP2".as_slice(),
            &1u32.to_le_bytes(),
            &2u32.to_le_bytes(),
            &0u64.to_le_bytes(),
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

    fn typed(tags: &[TypeTag], policy: SpillPolicy) -> ResultStore {
        let columns = tags
            .iter()
            .enumerate()
            .map(|(i, &type_tag)| Column {
                name: format!("c{i}"),
                type_tag,
                db_type: String::new(),
                source: None,
            })
            .collect();
        ResultStore::with_policy(columns, policy)
    }

    fn column(s: &ResultStore, index: usize) -> Vec<Option<String>> {
        let mut out = Vec::new();
        s.rows(0, u64::MAX, &[index], |row| {
            out.push(row.get(0).map(str::to_owned))
        })
        .expect("rows");
        out
    }

    struct Owned(Vec<Option<String>>);

    impl RowView for Owned {
        fn len(&self) -> usize {
            self.0.len()
        }
        fn get(&self, index: usize) -> Option<&str> {
            self.0.get(index).and_then(Option::as_deref)
        }
    }

    #[test]
    fn spills_full_chunks_to_disk_and_reads_them_back() {
        let dir = tempfile::tempdir().expect("dir");
        let s = typed(
            &[TypeTag::Integer, TypeTag::Text],
            SpillPolicy {
                threshold: Some(1024),
                dir: Some(dir.path().to_owned()),
            },
        );
        let total = CHUNK_ROWS * 3 + 7;
        for i in 0..total {
            let label = (!i.is_multiple_of(5)).then(|| format!("row {i} {}", "x".repeat(i % 13)));
            s.push(&Owned(vec![Some(i.to_string()), label]))
                .expect("push");
        }
        s.finish();
        assert!(s.spilled_bytes() > 0, "full chunks were written out");
        // Only the open chunk's text, plus offsets and bitmaps, stays.
        let text_left: u64 = s.read().expect("read").text_in_memory;
        assert!(text_left < (CHUNK_ROWS * 40) as u64, "{text_left}");

        // A page across the spilled/in-memory boundary decodes exactly.
        let around = (CHUNK_ROWS * 3 - 2) as u64;
        let (first, rows) = decode(&s.page(around, 5).expect("page"));
        assert_eq!(first, around);
        for (k, row) in rows.iter().enumerate() {
            let i = around as usize + k;
            assert_eq!(row[0].as_deref(), Some(i.to_string().as_str()));
            let want = (!i.is_multiple_of(5)).then(|| format!("row {i} {}", "x".repeat(i % 13)));
            assert_eq!(row[1], want);
        }
        // Sorting reads spilled text too.
        s.sort(Some((0, SortDirection::Descending))).expect("sort");
        let (_, top) = decode(&s.page(0, 1).expect("page"));
        assert_eq!(top[0][0].as_deref(), Some((total - 1).to_string().as_str()));
    }

    #[test]
    fn a_huge_text_chunk_closes_early_and_pages_still_line_up() {
        let s = typed(&[TypeTag::Text], SpillPolicy::default());
        let big = "y".repeat(CHUNK_TEXT_BYTES / 2 + 1);
        for _ in 0..5 {
            s.push(&Owned(vec![Some(big.clone())])).expect("push");
        }
        s.push(&Owned(vec![Some("tail".into())])).expect("push");
        assert!(s.read().expect("read").chunks.len() >= 3);
        let (_, rows) = decode(&s.page(4, 2).expect("page"));
        assert_eq!(rows[0][0].as_deref().map(str::len), Some(big.len()));
        assert_eq!(rows[1][0].as_deref(), Some("tail"));
    }

    #[test]
    fn sorts_numbers_as_numbers_with_nulls_last_going_up() {
        let s = typed(&[TypeTag::Integer, TypeTag::Text], SpillPolicy::default());
        for (n, t) in [
            (Some("10"), "b"),
            (None, "n"),
            (Some("9"), "a"),
            (Some("-3"), "c"),
            (Some("170141183460469231731687303715884105727"), "big"),
        ] {
            s.push(&Owned(vec![n.map(str::to_owned), Some(t.into())]))
                .expect("push");
        }
        assert!(
            s.sort(Some((0, SortDirection::Ascending))).is_err(),
            "not finished"
        );
        s.finish();
        assert!(s.push(&Row(vec![Some("1"), Some("x")])).is_err());

        s.sort(Some((0, SortDirection::Ascending))).expect("sort");
        let ns: Vec<_> = column(&s, 1);
        assert_eq!(ns, ["c", "a", "b", "big", "n"].map(|t| Some(t.to_owned())));
        s.sort(Some((0, SortDirection::Descending))).expect("sort");
        assert_eq!(
            column(&s, 1)[0].as_deref(),
            Some("n"),
            "NULLs first going down"
        );
        s.sort(None).expect("unsort");
        assert_eq!(column(&s, 1)[0].as_deref(), Some("b"));
        assert!(s.sort(Some((7, SortDirection::Ascending))).is_err());
    }

    #[test]
    fn sorts_are_stable_so_they_compose() {
        let s = typed(&[TypeTag::Text, TypeTag::Float], SpillPolicy::default());
        for (g, v) in [
            ("b", "2.5"),
            ("a", "NaN"),
            ("b", "1e3"),
            ("a", "-Infinity"),
            ("a", "0.1"),
        ] {
            s.push(&Owned(vec![Some(g.into()), Some(v.into())]))
                .expect("push");
        }
        s.finish();
        s.sort(Some((1, SortDirection::Ascending)))
            .expect("by value");
        s.sort(Some((0, SortDirection::Ascending)))
            .expect("then by group");
        let mut got = Vec::new();
        s.rows(0, 10, &[0, 1], |row| {
            got.push(format!(
                "{}{}",
                row.get(0).unwrap_or(""),
                row.get(1).unwrap_or("")
            ));
        })
        .expect("rows");
        assert_eq!(got, ["a-Infinity", "a0.1", "aNaN", "b2.5", "b1e3"]);
    }

    #[test]
    fn rows_picks_columns_in_the_order_asked() {
        let s = store(3);
        s.push(&Row(vec![Some("a"), None, Some("c")]))
            .expect("push");
        let mut got = Vec::new();
        s.rows(0, 1, &[2, 0, 1], |row| {
            got = (0..row.len())
                .map(|i| row.get(i).map(str::to_owned))
                .collect();
        })
        .expect("rows");
        assert_eq!(got, [Some("c".into()), Some("a".into()), None]);
        assert!(s.rows(0, 1, &[3], |_| {}).is_err());
    }

    #[test]
    fn pages_carry_each_rows_source_and_source_rows_read_back() {
        let s = typed(&[TypeTag::Integer, TypeTag::Text], SpillPolicy::default());
        for (n, t) in [("3", Some("c")), ("1", None), ("2", Some("b"))] {
            s.push(&Owned(vec![Some(n.to_owned()), t.map(str::to_owned)]))
                .expect("push");
        }
        s.finish();
        s.sort(Some((0, SortDirection::Ascending))).expect("sort");
        let page = s.page(0, 3).expect("page");
        let sources: Vec<u64> = {
            // Row by row: 8 bytes of source, then two cells.
            let mut at = 20;
            let mut out = Vec::new();
            for _ in 0..3 {
                out.push(u64::from_le_bytes(page[at..at + 8].try_into().expect("8")));
                at += 8;
                for _ in 0..2 {
                    let len = u32::from_le_bytes(page[at..at + 4].try_into().expect("4"));
                    at += 4 + if len == NULL_LENGTH { 0 } else { len as usize };
                }
            }
            out
        };
        assert_eq!(sources, [1, 2, 0]);
        assert_eq!(s.source_row(1).expect("row"), [Some("1".to_owned()), None]);
        assert!(s.source_row(3).is_err());
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

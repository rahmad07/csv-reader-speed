// Fast CSV reader: the same answers as csv-reader 1.0.0, faster.
//
// The reference reads one character at a time and grows every field a
// character at a time. This one reads the same way, left to right, with the
// same broken-row policy, but jumps instead of stepping: an unquoted field is
// found with a single native search for its next delimiter and sliced out in
// one piece; a quoted field is found with indexOf('"') and sliced out in
// pieces; a piece is only re-scanned when it actually holds a line break.
// Nothing here copies the reference's code: the shape below is my own.
//
// Policy (identical to the reference): a U+FEFF at the very start is dropped;
// a record ends at LF or CRLF, and a line left with no characters is no
// record; outside quotes a CR not followed by LF is dropped (stray_cr); a
// field that opens with a quote runs to the next quote that is not doubled,
// "" inside it is one quote and each CRLF or lone CR inside it is read as LF;
// what follows its closing quote, up to the next comma or line break, is
// appended as it stands (quote_junk, when the field ends); a quote that never
// closes is a literal character, and the text after it is read again as
// unquoted (unterminated_quote); a quote inside an unquoted field is literal.
// Fields stay strings, never trimmed or converted. columns is the first
// record when header is true, else null; rows holds the records after it
// (every record when header is false), each padded with "" (short_row, with
// fields: its field count) or cut (long_row, with extra: the cut fields) to
// the first record's width. Each error is {code, line, row}, in the order met,
// a field's quote_junk when the field ends and a record's short_row or
// long_row when the record ends: line the 1-based line its record starts on
// (every LF, CRLF and lone CR inside quotes counted), row its record's index
// in rows (null for the header).

const DELIM = /[,\r\n]/g; // next comma, CR or LF, from a position
const LF_ONLY = /\n/g; // line feeds, for counting
const ANY_BREAK = /\r\n?|\n/g; // any line break, for counting
const CR_ONLY = /\r\n?/g; // a CR or CRLF, for normalising to LF

const COMMA = 0; // how a field ended: at a comma (the record goes on)
const LINE_BREAK = 1; // at a line break (the record ends)
const END = 2; // at the end of the text (the record ends)

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How the last field ended, and how many characters its scan added.
  let fEnded = END;
  let fAdded = 0;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // A piece taken from inside quotes, appended to value: CRLF and a lone CR
  // each become one LF, and line counts each line break in the piece.
  function appendChunk(value, chunk) {
    if (chunk.indexOf('\r') === -1) {
      if (chunk.indexOf('\n') === -1) return value + chunk;
      line += chunk.match(LF_ONLY).length;
      return value + chunk;
    }
    const breaks = chunk.match(ANY_BREAK);
    if (breaks !== null) line += breaks.length;
    return value + chunk.replace(CR_ONLY, '\n');
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field;
  // fEnded says how it ended and fAdded how many characters were kept.
  function scanUnquoted(value) {
    let added = 0;
    let p = pos;
    for (;;) {
      DELIM.lastIndex = p;
      const m = DELIM.exec(text);
      if (m === null) {
        if (p < len) {
          value += text.slice(p);
          added += len - p;
        }
        pos = len;
        fEnded = END;
        fAdded = added;
        return value;
      }
      const i = m.index;
      const ch = m[0];
      if (ch === ',') {
        value += text.slice(p, i);
        added += i - p;
        pos = i + 1;
        fEnded = COMMA;
        fAdded = added;
        return value;
      }
      if (ch === '\n') {
        value += text.slice(p, i);
        added += i - p;
        pos = i + 1;
        line += 1;
        fEnded = LINE_BREAK;
        fAdded = added;
        return value;
      }
      // ch is '\r'.
      if (text.charCodeAt(i + 1) === 10) {
        value += text.slice(p, i);
        added += i - p;
        pos = i + 2;
        line += 1;
        fEnded = LINE_BREAK;
        fAdded = added;
        return value;
      }
      err('stray_cr');
      value += text.slice(p, i);
      added += i - p;
      p = i + 1;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        err('unterminated_quote');
        return scanUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        value = appendChunk(value, text.slice(p, q));
        value += '"';
        p = q + 2;
        continue;
      }
      value = appendChunk(value, text.slice(p, q));
      const after = q + 1;
      if (after >= len) {
        pos = len;
        fEnded = END;
        return value;
      }
      const c = text.charCodeAt(after);
      if (c === 44) {
        pos = after + 1;
        fEnded = COMMA;
        return value;
      }
      if (c === 10) {
        pos = after + 1;
        line += 1;
        fEnded = LINE_BREAK;
        return value;
      }
      if (c === 13 && text.charCodeAt(after + 1) === 10) {
        pos = after + 2;
        line += 1;
        fEnded = LINE_BREAK;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      pos = after;
      const junk = scanUnquoted(value);
      if (fAdded > 0) err('quote_junk');
      return junk;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? scanQuoted() : scanUnquoted(''));
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

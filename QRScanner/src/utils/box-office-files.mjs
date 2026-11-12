// utils/box-office-files.mjs
//
// The two nightly box-office files, built exactly the way
// DailyPgQueryAndSftp's nightly job builds them (its convertToCSV,
// escapeCSVField and buildEborXml), so a file downloaded from the Box Office
// Reports page matches what goes to the reporting FTP feeds. No imports on
// purpose: DailyPgQueryAndSftp's own tests import this file and check the
// two copies give identical bytes, so they can't drift apart.

// RTS_<theatre id>_<YYYYMMDD>0000.csv and FRG_<EBOR theatre no>_<YYYYMMDD>0000.xml
export function boxOfficeFileNames(reportDate, theaterId, eborTheatreNo) {
  const stamp = reportDate.replace(/-/g, '') + '0000';
  return {
    rts: `RTS_${theaterId}_${stamp}.csv`,
    frg: eborTheatreNo ? `FRG_${eborTheatreNo}_${stamp}.xml` : null
  };
}

// RFC 4180 field quoting.
export function escapeCSVField(field) {
  if (field === null || field === undefined) {
    return '';
  }
  field = String(field);
  if (field.includes(',') || field.includes('\n') || field.includes('\r') || field.includes('"')) {
    field = '"' + field.replace(/"/g, '""') + '"';
  }
  return field;
}

// The RTS (BDOR) CSV: no header row, CRLF line ends, columns in the order
// get_bdor_grouped_for_date returns them. No rows = "No data found\n".
export function buildRtsCsv(rows) {
  if (!rows || rows.length === 0) {
    return 'No data found\n';
  }
  const columns = Object.keys(rows[0]);
  let csv = '';
  for (const row of rows) {
    const values = columns.map(col => {
      const value = row[col];
      if (value === null || value === undefined) {
        return '';
      }
      return escapeCSVField(String(value));
    });
    csv += values.join(',') + '\r\n';
  }
  return csv;
}

// The FRG (EBOR) nightly XML from get_ebor_engagements_for_date's rows.
export function buildEborXml(rows, reportDate, theatreNo) {
  const dateTag = reportDate.replace(/-/g, '');
  const lines = [
    '<Nightly_box_office>',
    `<${dateTag}>`
  ];
  for (const r of rows) {
    const title = String(r.Title || '')
      .replace(/,/g, ' ')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .trim();
    const filmCode = String(r['Film Code'] || '').trim();
    const gross = Number(r.Gross || 0).toFixed(2);
    lines.push(`${theatreNo},${filmCode},${title},${gross}`);
  }
  lines.push(`</${dateTag}>`);
  lines.push('</Nightly_box_office>');
  lines.push('');
  return lines.join('\n');
}

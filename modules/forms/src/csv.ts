/** CSV helpers with spreadsheet formula-injection protection. */

/** Escape one cell (RFC 4180) and neutralise leading =, +, -, @ (and tab/CR) so spreadsheets don't evaluate it. */
export function csvCell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (typeof value !== 'number' && /^\s*[=+\-@]|^[\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

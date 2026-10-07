import { ModuloError } from '@modulo/kernel';

/** Output port: commands never touch process.stdout directly so tests can capture output. */
export interface IO {
  out(line?: string): void;
  err(line?: string): void;
}

export const processIO: IO = {
  out: (line = '') => process.stdout.write(line + '\n'),
  err: (line = '') => process.stderr.write(line + '\n'),
};

/** IO that records everything (tests). */
export function memoryIO(): IO & { stdout: string[]; stderr: string[]; text(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (l = '') => void stdout.push(l),
    err: (l = '') => void stderr.push(l),
    text: () => [...stdout, ...stderr].join('\n'),
  };
}

/** Render rows as an aligned plain-text table. */
export function table(headers: string[], rows: (string | number | null | undefined)[][]): string[] {
  const cells = rows.map((r) => headers.map((_, i) => String(r[i] ?? '')));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)];
}

/** Error raised for bad command-line usage (printed with the command's usage). */
export class UsageError extends Error {}

/** Print an error nicely: ModuloError message + details. Returns the exit code. */
export function reportError(e: unknown, io: IO): number {
  if (e instanceof UsageError) {
    io.err(`error: ${e.message}`);
    return 2;
  }
  if (e instanceof ModuloError) {
    io.err(`error: ${e.message}`);
    if (e.details !== undefined) {
      const details = Array.isArray(e.details) ? e.details : [e.details];
      for (const d of details) {
        const text = typeof d === 'string' ? d : formatDetail(d);
        if (!e.message.includes(text)) io.err(`  - ${text}`);
      }
    }
    return 1;
  }
  const err = e as any;
  io.err(`error: ${err?.message ?? String(e)}`);
  if (err?.problems && Array.isArray(err.problems)) for (const p of err.problems) io.err(`  - ${typeof p === 'string' ? p : formatDetail(p)}`);
  if (process.env.MODULO_DEBUG && err?.stack) io.err(err.stack);
  return 1;
}

function formatDetail(d: any): string {
  if (d && typeof d === 'object' && 'module' in d && 'message' in d) return `${d.module}: ${d.message}`;
  if (d && typeof d === 'object' && 'message' in d) return `${(d.path ?? []).join('.') || ''}${d.path?.length ? ': ' : ''}${d.message}`;
  return JSON.stringify(d);
}

// Disposable preload used only by verifier-fd.test.mjs, never a production selector.
import { fstatSync, readSync, writeSync } from 'node:fs';
const cases = JSON.parse(new URL(import.meta.url).searchParams.get('cases'));
const results = cases.map(c => {
  let same = false, error = null, readable = false, writable = false;
  try {
    const s = fstatSync(c.fd, { bigint: true });
    same = s.dev.toString() === c.dev && s.ino.toString() === c.ino;
    // Never confuse a reused descriptor number with the inherited capability.
    if (same) {
      const bytes = Buffer.alloc(Buffer.byteLength(c.canary));
      const n = readSync(c.fd, bytes, 0, bytes.length, c.kind === 'file' ? 0 : null);
      readable = n === bytes.length && bytes.toString() === c.canary;
      const reply = Buffer.from(c.reply);
      writable = writeSync(c.fd, reply, 0, reply.length, c.kind === 'file' ? bytes.length : null) === reply.length;
    }
  } catch (e) { error = e.code; }
  return { fd: c.fd, kind: c.kind, same, readable, writable, error };
});
const input = Buffer.alloc(1);
const stdinEof = readSync(0, input, 0, 1, null) === 0;
writeSync(2, 'FD_BOUNDARY_STDERR_OK\n');
writeSync(1, 'FD_BOUNDARY_PROBE ' + JSON.stringify({ results, stdinEof }) + '\n');

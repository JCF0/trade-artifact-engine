import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { canonicalJson, cloneAndFreeze, sha256CanonicalJson } from '../contract.mjs';
function stop() { throw Error('SUPERVISED_JOURNAL_INVALID'); }
// Open an existing provisioned private root. No authority provisioning or reset.
export function createSupervisedJournalV1(root) { return openJournal(root, false); }
// Administrator-only provisioning; never called by a runtime opener.
export function provisionSupervisedJournalV1(root) { openJournal(root, true); }
function openJournal(root, provision) {
  const initial = lstatSync(root);
  if (!isAbsolute(root) || realpathSync(root) !== root || !initial.isDirectory() || initial.uid !== process.getuid() || (initial.mode & 0o077)) stop();
  const records = []; let previous = null;
  function check() {
    const st = lstatSync(root);
    if (!st.isDirectory() || st.ino !== initial.ino || st.dev !== initial.dev || st.uid !== initial.uid || (st.mode & 0o077)) stop();
  }
  function read(name) {
    check(); const fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 33554432) stop();
      const bytes = readFileSync(fd), record = JSON.parse(bytes);
      if (!Buffer.from(canonicalJson(record)).equals(bytes)) stop();
      return record;
    } finally { closeSync(fd); }
  }
  const names = readdirSync(root).filter(n => n.startsWith('supervised-record-')).sort();
  if (names.length > 1024) stop();
  for (let i = 0; i < names.length; i++) {
    if (names[i] !== `supervised-record-${String(i + 1).padStart(4, '0')}.json`) stop();
    const value = read(names[i]);
    if (value.version !== 'artifact_supervised_journal_entry_v1' || value.sequence !== i + 1
      || value.previous_sha256 !== previous || Object.keys(value).sort().join(',') !== 'previous_sha256,record,sequence,version') stop();
    previous = sha256CanonicalJson(value); records.push(cloneAndFreeze(value.record));
  }
  function exclusive(name, value) {
    check(); const bytes = Buffer.from(canonicalJson(value));
    if (bytes.length > 33554432) stop();
    const fd = openSync(join(root, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { let n = 0; while (n < bytes.length) { const k = writeSync(fd, bytes, n); if (!k) stop(); n += k; } fsyncSync(fd); }
    finally { closeSync(fd); }
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    check();
  }
  const headName = 'supervised-head.json';
  const head = () => ({ version: 'artifact_supervised_journal_head_v1', sequence: records.length, journal_sha256: previous });
  if (provision) {
    if (readdirSync(root).some(n => n.startsWith('supervised-'))) stop();
    exclusive(headName, head());
  }
  function verify() {
    if (canonicalJson(read(headName)) !== canonicalJson(head())) stop();
    const current = readdirSync(root).filter(n => n.startsWith('supervised-record-')).sort();
    if (current.length !== records.length) stop();
    let digest = null;
    for (const [i, record] of records.entries()) {
      if (current[i] !== `supervised-record-${String(i + 1).padStart(4, '0')}.json`) stop();
      const entry = read(current[i]);
      if (entry.previous_sha256 !== digest || canonicalJson(entry.record) !== canonicalJson(record)) stop();
      digest = sha256CanonicalJson(entry);
    }
    if (digest !== previous) stop();
    const phases = records.filter(r => r.kind === 'phase_consumed');
    const markers = readdirSync(root).filter(n => n.startsWith('supervised-') && n.endsWith('.consumed.json'));
    if (markers.length !== phases.length) stop();
    for (const { phase, ordinal } of phases) {
      const expected = { version: 'artifact_supervised_phase_consumption_v1', phase, ordinal };
      if (canonicalJson(read(`supervised-${phase}-${ordinal}.consumed.json`)) !== canonicalJson(expected)) stop();
    }
  }
  verify();
  function retain(record) {
    if (records.length >= 1024 || canonicalJson(read(headName)) !== canonicalJson(head())) stop();
    const owned = cloneAndFreeze(record), sequence = records.length + 1;
    const value = { version: 'artifact_supervised_journal_entry_v1', sequence, previous_sha256: previous, record: owned };
    exclusive(`supervised-record-${String(sequence).padStart(4, '0')}.json`, value);
    previous = sha256CanonicalJson(value); records.push(owned);
    exclusive('supervised-head-next.json', head());
    renameSync(join(root, 'supervised-head-next.json'), join(root, headName));
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return previous;
  }
  return Object.freeze({
    retain,
    claimPhase(phase, ordinal) {
      if (!['capture', 'simulation', 'economic_source'].includes(phase) || ![1, 2].includes(ordinal)) stop();
      verify();
      exclusive(`supervised-${phase}-${ordinal}.consumed.json`, { version: 'artifact_supervised_phase_consumption_v1', phase, ordinal });
      retain({ kind: 'phase_consumed', phase, ordinal });
    },
    snapshot() { verify(); return cloneAndFreeze({ journal_sha256: previous, records }); },
  });
}

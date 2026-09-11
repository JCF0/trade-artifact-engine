"""Synthetic-only failure injection through the real credential publication code."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('entry', HERE / 'credential-entry.py')
assert spec is not None and spec.loader is not None
entry = importlib.util.module_from_spec(spec); spec.loader.exec_module(entry)


def run(selection='all'):
    cases = ['partial-write', 'file-fsync', 'staging-directory-fsync', 'publication',
             'publication-uncertain', 'unlink', 'final-directory-fsync', 'short-writes', 'success', 'race']
    if selection != 'all': cases = [selection]
    results = []
    for case in cases:
        with tempfile.TemporaryDirectory(prefix='artifact-publication-synthetic-') as tmp:
            root = Path(tmp); directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            final = root / entry.custody.NAME; pending = root / (entry.custody.NAME + '.pending')
            key = bytearray(b'SYNTHETIC_PUBLICATION_KEY_0001')
            expected = b'HELIUS_API_KEY=' + bytes(key) + b'\n'
            original = {n:getattr(os,n) for n in ('write','fsync','link','unlink')}
            writes = 0; directory_syncs = 0; publication_seen = False
            def write(fd, data):
                nonlocal writes
                writes += 1
                # Incomplete data is invisible at the final name, including while writing.
                if writes == 1 and case != 'partial-write': assert not final.exists()
                if case == 'partial-write':
                    if writes == 1: return original['write'](fd, data[:32])
                    raise OSError('SYNTHETIC_WRITE_FAILURE')
                return original['write'](fd, data[:3] if case == 'short-writes' else data)
            def fsync(fd):
                nonlocal directory_syncs
                if fd == directory: directory_syncs += 1
                if ((case == 'file-fsync' and fd != directory) or
                    (case == 'staging-directory-fsync' and fd == directory and directory_syncs == 1) or
                    (case == 'final-directory-fsync' and fd == directory and directory_syncs == 2)):
                    raise OSError('SYNTHETIC_FSYNC_FAILURE')
                return original['fsync'](fd)
            def link(*args, **kwargs):
                nonlocal publication_seen
                publication_seen = True
                assert pending.read_bytes() == expected and not final.exists()
                if case == 'publication': raise OSError('SYNTHETIC_PUBLICATION_FAILURE')
                if case == 'race':
                    final.write_bytes(b'PREEXISTING_SYNTHETIC_FILE')
                result = original['link'](*args, **kwargs)
                assert final.read_bytes() == expected
                if case == 'publication-uncertain': raise OSError('SYNTHETIC_LOST_PUBLICATION_ACK')
                return result
            def unlink(*args, **kwargs):
                if case == 'unlink': raise OSError('SYNTHETIC_UNLINK_FAILURE')
                return original['unlink'](*args, **kwargs)
            for name, fn in [('write',write),('fsync',fsync),('link',link),('unlink',unlink)]: setattr(os,name,fn)
            success = False
            try:
                try: entry._store(directory, key); success = True
                except entry.custody.CustodyStop: pass
            finally:
                for name, fn in original.items(): setattr(os,name,fn)
            try:
                assert key == bytearray(len(key))
                assert success == (case in ('success','short-writes'))
                if case in ('partial-write','file-fsync','staging-directory-fsync','publication'):
                    assert not final.exists(), 'INCOMPLETE_OR_FAILED_WRITE_PUBLISHED'
                    assert pending.exists(), 'FAILED_ATTEMPT_NOT_RETAINED'
                elif case == 'race': assert final.read_bytes() == b'PREEXISTING_SYNTHETIC_FILE'
                else: assert final.read_bytes() == expected
                if success:
                    assert publication_seen and not pending.exists()
                    st = final.stat(); assert st.st_uid == st.st_gid == 0 and st.st_nlink == 1 and st.st_mode & 0o777 == 0o600
                # Even incomplete prepublication attempts block automatic rerun.
                before = {p.name:p.read_bytes() for p in root.iterdir()}
                try: entry._store(directory, bytearray(b'DIFFERENT_SYNTHETIC_KEY_0001')); raise AssertionError('RETRY_ALLOWED')
                except entry.custody.CustodyStop: pass
                assert before == {p.name:p.read_bytes() for p in root.iterdir()}
                results.append(dict(case=case, passed=True, success_reported=success,
                                    final_present=final.exists(), pending_retained=pending.exists()))
            finally: os.close(directory)
    print(json.dumps(dict(passed=True, cases=results, real_credential_reads=0, external_requests=0)))


if __name__ == '__main__': run(sys.argv[1] if len(sys.argv) == 2 else 'all')

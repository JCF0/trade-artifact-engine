"""Synthetic terminal-entry tests; real fixed credential path is never accessed."""
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import signal
import tempfile
import termios
import time

HERE = Path(__file__).resolve().parent


def run():
    path = HERE / 'credential-entry.py'
    assert path.is_file(), 'SECURE_ENTRY_HELPER_MISSING'
    spec = importlib.util.spec_from_file_location('entry', path)
    assert spec is not None and spec.loader is not None
    entry = importlib.util.module_from_spec(spec); spec.loader.exec_module(entry)
    checks = []
    with tempfile.TemporaryDirectory(prefix='artifact-entry-synthetic-') as tmp:
        root = Path(tmp); (root / 'root').mkdir(mode=0o700)
        original = os.open
        def opened(name, *args, **kwargs):
            return original(str(root) if name == '/' else name, *args, **kwargs)
        # Actual interactive main in a disposable controlling terminal.
        pid, master = pty.fork()
        if pid == 0:
            os.open = opened
            try: code = entry.main()
            except BaseException: code = 1
            os._exit(code)
        transcript = bytearray(); sent = 0; key = b'SYNTHETIC_OPERATOR_KEY_0001'
        try:
            end = time.monotonic() + 5
            status = None
            while time.monotonic() < end:
                readable, _, _ = select.select([master], [], [], 0.05)
                if readable:
                    try: data = os.read(master, 4096)
                    except OSError: data = b''
                    transcript.extend(data)
                    marker = b'New Helius key: ' if sent == 0 else b'Confirm Helius key: '
                    if sent < 2 and marker in transcript:
                        assert not termios.tcgetattr(master)[3] & termios.ECHO
                        os.write(master, key + b'\n'); sent += 1
                done, status_value = os.waitpid(pid, os.WNOHANG)
                if done: status = status_value; break
            assert status is not None and os.waitstatus_to_exitcode(status) == 0
            while select.select([master], [], [], 0)[0]:
                try: data = os.read(master, 4096)
                except OSError: break
                if not data: break
                transcript.extend(data)
            assert sent == 2 and key not in transcript
            assert b'ARTIFACT_CREDENTIAL_ENTRY_PUBLISHED: no request sent.' in transcript
            checks.append('interactive-no-echo-and-confirmation')
        finally:
            try: os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
            except ProcessLookupError: pass
            except ChildProcessError: pass
            os.close(master)
        target = root / 'root/.artifact-qualification/helius.env'
        assert target.read_bytes() == b'HELIUS_API_KEY=' + key + b'\n'
        st = target.stat(); assert st.st_uid == st.st_gid == 0 and st.st_mode & 0o777 == 0o600 and st.st_nlink == 1
        checks.append('root-owned-0600-named-file')
        fd = original(str(target.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            before = target.read_bytes()
            try: entry._store(fd, bytearray(b'OTHER_SYNTHETIC_KEY_0001')); raise AssertionError('OVERWROTE')
            except entry.custody.CustodyStop: pass
            assert target.read_bytes() == before
            checks.append('exclusive-create-preserves-existing')
            target.unlink(); target.symlink_to(root / 'unrelated')
            try: entry._store(fd, bytearray(key)); raise AssertionError('FOLLOWED_LINK')
            except entry.custody.CustodyStop: pass
            assert not (root / 'unrelated').exists()
            checks.append('symlink-no-overwrite')
            target.unlink()
            try: entry._store(fd, bytearray(b'bad\nvalue')); raise AssertionError('BAD_VALUE')
            except entry.custody.CustodyStop: pass
            assert not target.exists()
            checks.append('invalid-key-no-file')
        finally: os.close(fd)
        # No controlling terminal must fail closed, never getpass's echoing fallback.
        pid = os.fork()
        if pid == 0:
            os.setsid(); os.open = opened
            null = original('/dev/null', os.O_RDWR)
            for n in (0, 1, 2): os.dup2(null, n)
            os._exit(0 if entry.main() == 1 else 1)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0 and not target.exists()
        checks.append('no-terminal-fails-closed')
    print(json.dumps(dict(passed=True, checks=checks, synthetic_only=True, real_credential_reads=0, external_requests=0)))


if __name__ == '__main__': run()

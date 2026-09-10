"""Real anonymous pipes in a disposable subprocess, not cross-UID confinement."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
for case in ['valid', 'duplicate', 'conflict', 'over-limit', 'missing-eof', 'wrong-role', 'aliased', 'output-loss']:
    with tempfile.TemporaryDirectory(prefix='artifact-fd-fixture-') as root:
        handles = []; targets = {}; peers = {}
        def retain(fd):
            copy = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 64); os.close(fd); handles.append(copy); return copy
        for number in [3, 4, 5]:
            path = Path(root) / ('synthetic-%d' % number)
            path.write_bytes(b'{}'); path.chmod(0o600)
            targets[number] = retain(os.open(path, os.O_RDONLY))
        for number in range(6, 16):
            r, w = os.pipe()
            if number in [6, 9, 12]: targets[number], peers[number] = retain(r), retain(w)
            else: peers[number], targets[number] = retain(r), retain(w)
        if case == 'wrong-role': targets[6] = targets[3]
        if case == 'aliased': targets[4] = targets[3]
        # Only this dedicated fixture process changes its own descriptor table.
        for number, handle in targets.items(): os.dup2(handle, number, inheritable=True)
        child = subprocess.Popen(['/usr/local/bin/node', str(HERE / 'fd-probe.mjs')],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=tuple(targets), env={}, close_fds=True)
        for number in targets: os.close(number)
        if case == 'output-loss': os.close(peers[8]); handles.remove(peers[8])
        payload = b'{\n  "synthetic": true\n}\n'
        if case == 'duplicate': payload += payload
        if case == 'conflict': payload += b'{\n  "synthetic": false\n}\n'
        if case == 'over-limit': payload = b' ' * 131073
        # Do not let the parent fill a pipe and deadlock against a refusing child.
        if case != 'missing-eof':
            os.set_blocking(peers[6], False)
            offset = 0
            import select
            while offset < len(payload) and child.poll() is None:
                try: offset += os.write(peers[6], payload[offset:])
                except BlockingIOError: select.select([], [peers[6]], [], .05)
                except BrokenPipeError: break
            os.close(peers[6]); handles.remove(peers[6])
        out, err = child.communicate(timeout=10)
        if case == 'valid':
            assert child.returncode == 0, err.decode()
            assert json.loads(os.read(peers[8], 4096)) == dict(status='FIXTURE_FD_ACCEPTED')
        else: assert child.returncode != 0, case
        for handle in handles:
            try: os.close(handle)
            except OSError: pass
        print(json.dumps(dict(case=case, exit=child.returncode, same_uid=True, actual_anonymous_pipes=True)), flush=True)

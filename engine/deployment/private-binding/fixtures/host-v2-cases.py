"""Closed pipe-only synthetic host fixture: no wallet/runtime/transport/path input."""
import importlib.util
import json
import os
from pathlib import Path
import resource
import signal
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location('host', Path(__file__).parents[1] / 'host-launch-v2.py')
assert spec is not None and spec.loader is not None
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
assert len(sys.argv) == 1
assert os.environ.get('ARTIFACT_PARENT_NET_NS') != os.readlink('/proc/self/ns/net')
assert host.LIBC.prctl(36, 1, 0, 0, 0) == 0  # child subreaper before fork
assert hasattr(host, 'bind_parent_death'), 'missing hard supervisor parent-loss chain'
ready_r, ready_w = os.pipe()
parent = os.fork()
if parent == 0:
    expected = os.getpid()
    if os.fork() == 0:
        host.bind_parent_death(expected)
        os.write(ready_w, str(os.getpid()).encode())
    while True:
        time.sleep(10)
os.close(ready_w)
bound_child = int(os.read(ready_r, 100))
os.close(ready_r)
os.kill(parent, signal.SIGKILL)
assert os.waitpid(parent, 0)[1] == signal.SIGKILL
assert os.waitpid(bound_child, 0)[1] == signal.SIGKILL
assert hasattr(host, 'episode_seconds'), 'missing hard deadline from existing episode/runtime bounds'
assert host.episode_seconds({'episode_timeout_ms': 600000, 'runtime': {'deadline_unix_seconds': 110}}, 100) == 10
assert host.episode_seconds({'episode_timeout_ms': 1200, 'runtime': {'deadline_unix_seconds': 110}}, 100) == 1.2
for value in (0, True, 600001):
    try:
        host.episode_seconds({'episode_timeout_ms': value, 'runtime': {'deadline_unix_seconds': 110}}, 100)
        raise AssertionError('invalid deadline accepted')
    except ValueError:
        pass

def check_fds(expected):
    for fd in range(0, 80):
        try:
            os.fstat(fd)
            assert fd in expected, ('unexpected', fd)
        except OSError:
            assert fd not in expected, ('missing', fd)
    try:
        os.fstat(2048)
        raise AssertionError('high inherited descriptor retained')
    except OSError:
        pass


def role(which, case, mapping):
    host.close_except(mapping)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    os.environ.clear()
    os.environ.update(host.ENV)
    check_fds(set(mapping))
    assert resource.getrlimit(resource.RLIMIT_CORE) == (0, 0)
    if which == 'worker':
        identities = [(os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd in range(3, 16)]
        assert len(set(identities)) == 13
        for fd in range(3, 16):
            mode = host.fcntl.fcntl(fd, host.fcntl.F_GETFL) & os.O_ACCMODE
            assert mode == (os.O_RDONLY if fd in (3, 4, 5, 6, 9, 12) else os.O_WRONLY)
        assert all(os.read(fd, 64) == b'SYNTHETIC_NO_WALLET' for fd in (3, 4, 5))
        os.write(13, b'context\n')
        if case == 'escaped-deadline':
            child = os.fork()
            if child == 0:
                os.setsid()
                if os.fork():
                    os._exit(0)
                while True:
                    time.sleep(10)
            while True:
                time.sleep(10)
        os.write(7, b'acquisition\n')
        if case == 'revocation':
            assert os.read(12, 100) == b'revoke\n'
            assert os.read(12, 100) == b''
            os.write(14, b'ack\n')
        elif case == 'eof':
            assert os.read(6, 100) == b''
        else:
            assert os.read(6, 100) == b'signed-acquisition\n'
            assert os.read(6, 100) == b''
            try:
                os.write(8, b'result1\n')
            except BrokenPipeError:
                assert case == 'output-loss'
                os.write(15, b'STOPPED')
                return
            os.write(10, b'disposal\n')
            assert os.read(9, 100) == b'signed-disposal\n'
            assert os.read(9, 100) == b''
            os.write(11, b'result2\n')
        os.write(15, b'POSITIVE' if case == 'positive' else b'STOPPED')
    elif which == 'controller':
        assert os.read(7, 100) == b'acquisition\n'
        if case in ('eof', 'revocation'):
            os.close(6)
            # Human remains independent; worker closes controller outputs at exit.
            os.read(8, 100)
            return
        if case == 'escaped-deadline':
            return
        if case == 'output-loss':
            os.close(8)
        os.write(6, b'signed-acquisition\n')
        os.close(6)
        if case == 'output-loss':
            os.read(10, 100)
            return
        assert os.read(8, 100) == b'result1\n'
        assert os.read(10, 100) == b'disposal\n'
        os.write(9, b'signed-disposal\n')
        os.close(9)
        assert os.read(11, 100) == b'result2\n'
    else:
        assert os.read(13, 100) == b'context\n'
        if case == 'revocation':
            os.write(12, b'revoke\n')
            os.close(12)
            assert os.read(14, 100) == b'ack\n'
        else:
            os.read(14, 100)  # custody stays alive until worker EOF

for case in ('positive', 'eof', 'output-loss', 'revocation', 'escaped-deadline'):
    worker, controller, human, final, owned = host.pipes()
    null = os.open('/dev/null', os.O_RDWR)
    os.dup2(null, 2048)
    # Closed disposable regular paths; no input can choose an installed record.
    root = tempfile.TemporaryDirectory(prefix='artifact-host-v2-only-')
    for fd in (3, 4, 5):
        path = Path(root.name) / f'synthetic-{fd}'
        path.write_bytes(b'SYNTHETIC_NO_WALLET')
        path.chmod(0o600)
        source = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        worker[fd] = source
        owned.append(source)
    pids = []
    for name, mapping in [('worker', worker), ('controller', controller), ('human', human)]:
        mapping.update({0: null, 1: null, 2: 2})
        pid = os.fork()
        if pid == 0:
            try:
                role(name, case, mapping)
                os._exit(0)
            except BaseException as e:
                os.write(2, (repr((name, case, e)) + '\n').encode())
                os._exit(1)
        pids.append(pid)
    for fd in set(owned + [null, 2048]) - {final}:
        os.close(fd)
    result = host.supervise(pids, .35 if case == 'escaped-deadline' else 2)
    payload = os.read(final, 128)
    os.close(final)
    root.cleanup()
    assert result['clean'], result
    if case == 'escaped-deadline':
        assert result['timed']
    else:
        assert not result['timed'] and all(v == 0 for v in result['status'].values()), result
        assert len(result['status']) == 3
        assert payload == (b'POSITIVE' if case == 'positive' else b'STOPPED'), payload
    print(json.dumps(dict(case=case, closed=True, clean=result['clean'], timed=result['timed'],
                          same_uid_fixture=True, production_cross_uid_qualified=False)), flush=True)

"""Synthetic FD inheritance fixture; actual verifier + confinement + Node exec."""
import ctypes
import errno
import json
import os
from pathlib import Path
import resource
import runpy
import socket
import subprocess
import sys
import tempfile
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
VERIFIER = HERE.parent / 'verify-isolated.py'


def identity(fd, kind, canary, reply):
    st = os.fstat(fd)
    return dict(fd=fd, dev=str(st.st_dev), ino=str(st.st_ino), kind=kind, canary=canary, reply=reply)


def child():
    mode, encoded, *arguments = sys.argv[2:]
    cases = json.loads(encoded)
    for c in cases:
        s = os.fstat(c['fd'])
        assert str(s.st_dev) == c['dev'] and str(s.st_ino) == c['ino']
        assert os.get_inheritable(c['fd'])
    # Deliberately lower BOTH limits after inheritance, leaving high FDs open.
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    print('FD_BOUNDARY_INHERITED ' + json.dumps(dict(cases=cases, limits=resource.getrlimit(resource.RLIMIT_NOFILE))), flush=True)
    original_exec = os.execve
    def observed_exec(executable, argv, env):
        assert argv[0] == executable and argv[-2] == str(HERE.parent / 'verify.mjs') and env == {}
        print('FD_BOUNDARY_PREEXEC', flush=True)
        probe = (HERE / 'verifier-fd-probe.mjs').as_uri() + '?cases=' + quote(encoded, safe='')
        original_exec(executable, [argv[0], '--import', probe, *argv[1:]], env)
    os.execve = observed_exec
    if mode == 'unavailable':
        original_library = ctypes.CDLL
        class Library:
            def __init__(self, *args, **kwargs):
                self.lib = original_library(*args, **kwargs)
                def unavailable(*args):
                    ctypes.set_errno(errno.ENOSYS)
                    return -1
                self.close_range = unavailable
            def __getattr__(self, name):
                return getattr(self.lib, name)
        ctypes.CDLL = Library
    sys.argv = [str(VERIFIER), *arguments]
    runpy.run_path(str(VERIFIER), run_name='__main__')


def launch():
    mode, *arguments = sys.argv[2:]
    namespace = os.readlink('/proc/self/ns/net')
    assert namespace != os.environ['ARTIFACT_PARENT_NET_NS']
    links = json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', 'link']))
    routes = json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', 'route', 'show', 'table', 'all']))
    routes6 = json.loads(subprocess.check_output(['/usr/sbin/ip', '-6', '-j', 'route', 'show', 'table', 'all']))
    assert len(links) == 1 and links[0]['ifname'] == 'lo'
    assert all(r.get('dev') == 'lo' and r.get('type') in ('local', 'broadcast') for r in routes)
    assert all(r.get('dev') == 'lo' and r.get('type') in ('local', 'multicast') for r in routes6)
    assert resource.getrlimit(resource.RLIMIT_NOFILE)[0] > 65537, 'HIGH_FD_HOST_REQUIRED_NO_SKIP'
    fds = [200, 201, 65536, 65537]
    with tempfile.TemporaryFile() as file, socket.socket() as listener:
        file.write(b'SYNTHETIC_FILE_CANARY'); file.flush()
        listener.bind(('127.0.0.1', 0)); listener.listen(1)
        with socket.create_connection(listener.getsockname(), timeout=5) as client, listener.accept()[0] as peer:
            client.settimeout(None)
            peer.sendall(b'SYNTHETIC_SOCKET_CANARY')
            cases = []
            for fd in fds:
                kind = 'file' if fd % 2 == 0 else 'socket'
                os.dup2(file.fileno() if kind == 'file' else client.fileno(), fd, inheritable=True)
                cases.append(identity(fd, kind, 'SYNTHETIC_' + kind.upper() + '_CANARY', 'SYNTHETIC_' + kind.upper() + '_EFFECT'))
            try:
                process = subprocess.Popen(['/usr/bin/python3', str(Path(__file__).resolve()), 'child', mode,
                    json.dumps(cases), *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env={'PYTHONDONTWRITEBYTECODE': '1'}, close_fds=False)
            finally:
                for fd in fds: os.close(fd)
            client.close()
            try:
                stdout, stderr = process.communicate(timeout=120)
            except BaseException:
                process.kill(); process.communicate(); raise
            peer.settimeout(1)
            try:
                socket_effect = peer.recv(1024).decode()
            except ConnectionResetError:
                socket_effect = ''  # Closed without consuming the queued canary.
            file.seek(0); file_effect = file.read().decode()
            print(json.dumps(dict(exit=process.returncode, stdout=stdout.decode(), stderr=stderr.decode(),
                file_effect=file_effect, socket_effect=socket_effect, namespace=namespace,
                links=links, routes=routes, routes6=routes6, close_fds=False)))


if __name__ == '__main__':
    {'launch': launch, 'child': child}[sys.argv[1]]()

"""Qualification-only local supervisor. No credential discovery or live launch mode.

Uses temporary chroot + private mount/PID/network namespaces, existing nobody UID,
zero capabilities, no_new_privs, seccomp, full inherited-FD closure, and a parent
hard deadline. It never changes existing host permissions or provisions users.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import pwd
import resource
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path('/root/artifact/trade-artifact')
HERE = ROOT / 'engine/qualification/helius-provider'
E = Path('/root/artifact-private-helius-provider-qualification')
RUNTIME = Path('/root/artifact-private-helius-query-binding/runtime-frozen.json')
R = '1686d69ff98d821ee84a3d58722ea9842c04e49e4d2e4438203608913d91bb6c'
ACCEPTED = ['engine/deployment/private-binding/' + n for n in ['exchange.mjs', 'io.mjs', 'openssl.cnf']]
ACCEPTED += ['engine/src/verification-scope-v1-3/contract.mjs']
ACCEPTED += ['engine/src/verification-scope-v1-3/final-proof-agent/' + n for n in ['supervised-profile-v1.mjs', 'supervised-rpc-v1.mjs']]
ENV = dict(PATH='/bin', HOME='/nonexistent', USERPROFILE='/nonexistent', LANG='C.UTF-8', LC_ALL='C.UTF-8', TZ='UTC')

def sha(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def put(root, name, value):
    with (root / name).open('x') as f:
        json.dump(value, f, indent=2, sort_keys=True); f.write('\n'); f.flush(); os.fsync(f.fileno())
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)

def seccomp(libc):
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]
    class Program(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filters', ctypes.POINTER(Filter))]
    entries = [Filter(0x20, 0, 0, 4), Filter(0x15, 1, 0, 0xc000003e), Filter(0x06, 0, 0, 0x80000000), Filter(0x20, 0, 0, 0)]
    entries += [Filter(0x45, 0, 1, 0x40000000), Filter(0x06, 0, 0, 0x80000000)]
    # ptrace, process memory, io_uring, namespace/root/mount changes, BPF,
    # module/kexec and kernel-key operations. Networking stays loopback-only by NS.
    for number in [101, 155, 161, 165, 166, 175, 176, 246, 248, 249, 250, 272, 298, 303, 304, 308, 310, 311, 313, 321, 323, 425, 426, 427, 428, 429, 430, 431, 432, 433, 442]:
        entries += [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x50000 | errno.EACCES)]
    entries += [Filter(0x06, 0, 0, 0x7fff0000)]
    array = (Filter * len(entries))(*entries)
    program = Program(len(entries), array)
    assert libc.prctl(22, 2, ctypes.byref(program), 0, 0) == 0

def child(jail_name, mode, parent_net, parent_pid, outside):
    jail = Path(jail_name)
    assert os.uname().machine == 'x86_64'
    assert os.readlink('/proc/self/ns/net') != parent_net and os.readlink('/proc/self/ns/pid') != parent_pid
    subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True)
    links = json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', 'link']))
    routes = json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', 'route', 'show', 'table', 'all']))
    routes6 = json.loads(subprocess.check_output(['/usr/sbin/ip', '-6', '-j', 'route', 'show', 'table', 'all']))
    assert len(links) == 1 and links[0]['ifname'] == 'lo'
    assert all(r.get('dev') == 'lo' and r.get('type') in ('local', 'broadcast') for r in routes)
    assert all(r.get('dev') == 'lo' and r.get('type') in ('local', 'multicast') for r in routes6)
    subprocess.run(['/usr/bin/mount', '--make-rprivate', '/'], check=True)
    subprocess.run(['/usr/bin/mount', '-t', 'proc', 'proc', str(jail / 'proc'), '-o', 'nosuid,nodev,noexec,hidepid=2'], check=True)
    libc = ctypes.CDLL(None, use_errno=True)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    assert Path(outside).read_bytes() == b'PUBLIC_SYNTHETIC_INACCESSIBILITY_CANARY'
    # Exercise closure of inherited file AND connected socket above a lowered limit.
    assert os.fstat(1000) and os.fstat(1001)
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    close_range = libc.close_range
    close_range.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_int]
    close_range.restype = ctypes.c_int
    assert close_range(3, 4, 0) == 0 and close_range(6, ctypes.c_uint(-1).value, 0) == 0
    for fd in [1000, 1001]:
        try: os.fstat(fd); raise AssertionError('FD_CLOSURE_FAILED')
        except OSError as e: assert e.errno == errno.EBADF
    assert os.fstat(5).st_uid == 65534
    os.chroot(jail); os.chdir('/')
    for cap in range(41): assert libc.prctl(24, cap, 0, 0, 0) == 0
    os.setgroups([]); os.setgid(65534); os.setuid(65534)
    assert libc.prctl(38, 1, 0, 0, 0) == 0
    assert libc.prctl(4, 0, 0, 0, 0) == 0
    seccomp(libc)
    status = Path('/proc/self/status').read_text()
    caps = {k: int(next(s.split(':')[1] for s in status.splitlines() if s.startswith(k + ':')), 16)
            for k in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']}
    assert all(v == 0 for v in caps.values()) and 'NoNewPrivs:\t1' in status
    assert os.getuid() == os.geteuid() == 65534 and os.getgroups() == []
    assert not Path(outside).exists() and not Path('/proc/1/root' + outside).exists()
    assert not Path('/root/artifact/trade-artifact').exists()
    assert not Path('/var/lib/artifact-wiggles').exists()
    for number in [101, 310, 311, 425]:
        ctypes.set_errno(0)
        assert libc.syscall(number, 0, 0, 0, 0, 0, 0) == -1 and ctypes.get_errno() == errno.EACCES
    try: os.setuid(0); raise AssertionError('PRIVILEGE_REGAIN')
    except PermissionError: pass
    try: os.open('/bin/node', os.O_WRONLY); raise AssertionError('RELEASE_WRITE')
    except PermissionError: pass
    put(Path('/evidence'), 'isolation.json', dict(uid=os.getuid(), gid=os.getgid(), groups=os.getgroups(), capabilities=caps,
        no_new_privs=True, core_limit=resource.getrlimit(resource.RLIMIT_CORE), chroot=True,
        net_namespace=os.readlink('/proc/self/ns/net'), pid_namespace=os.readlink('/proc/self/ns/pid'),
        links=links, routes=routes, routes6=routes6, inherited_fd_keep=[0, 1, 2, 5], high_file_and_socket_closed=True,
        synthetic_outside_file_inaccessible=True, host_release_and_state_absent=True, ptrace_and_process_memory_denied=True,
        real_signer_access='NO_HOST_PATHS_OR_DESCRIPTORS_IN_JAIL', environment=ENV))
    if mode == 'cleanup-probe':
        os.close(5)
        pid = os.fork()
        if pid == 0:
            os.setsid(); put(Path('/evidence'), 'escaped.json', dict(pid=os.getpid(), sid=os.getsid(0)))
        while True: signal.pause()
    os.execve('/bin/node', ['/bin/node', '--openssl-config=/accepted/engine/deployment/private-binding/openssl.cnf', '/harness/local.mjs'], ENV)

def prepare(jail):
    assert sha(RUNTIME) == R
    runtime = json.loads(RUNTIME.read_bytes()); members = {m['resolved']: m for m in runtime['members']}
    for directory in ['bin', 'proc', 'dev', 'tmp', 'evidence', 'harness']:
        (jail / directory).mkdir(parents=True, mode=0o755)
    os.chmod(jail, 0o755); os.chmod(jail / 'evidence', 0o700); os.chown(jail / 'evidence', 65534, 65534)
    identities = []
    def copy(source, destination, accepted=True):
        source = Path(source).resolve(strict=True)
        if accepted:
            m = members[str(source)]; st = source.stat()
            assert sha(source) == m['sha256'] and st.st_size == m['bytes'] and stat.S_IMODE(st.st_mode) == m['mode']
        target = jail / destination.lstrip('/'); target.parent.mkdir(parents=True, exist_ok=True)
        # Newly created copies only; never chmod or chown an accepted input.
        shutil.copyfile(source, target); target.chmod(0o555 if destination == '/bin/node' or source.name == 'ld-linux-x86-64.so.2' else 0o444)
        identities.append(dict(source=str(source), jail_path=destination, sha256=sha(target), bytes=target.stat().st_size,
                               mode=stat.S_IMODE(target.stat().st_mode), accepted_R_member=accepted))
    node = next(m['resolved'] for m in runtime['members'] if m['path'] == 'runtime/node')
    copy(node, '/bin/node')
    for name in ACCEPTED: copy(ROOT / name, '/accepted/' + name)
    for name in ['bounded.mjs', 'probe.mjs', 'local.mjs']: copy(HERE / name, '/harness/' + name, False)
    for m in runtime['members']:
        if m['path'].startswith('runtime/shared/'):
            copy(m['resolved'], m['resolved'])
    os.symlink('usr/lib', jail / 'lib'); (jail / 'lib64').mkdir()
    os.symlink('/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', jail / 'lib64/ld-linux-x86-64.so.2')
    # ELF SONAME aliases, from the already accepted resolved libraries.
    for m in runtime['members']:
        if m['path'].startswith('runtime/shared/'):
            name = Path(m['resolved']).name
            if '.so.' in name:
                alias = name.split('.so.')[0] + '.so.' + name.split('.so.')[1].split('.')[0]
                p = jail / 'usr/lib/x86_64-linux-gnu' / alias
                if not p.exists(): os.symlink(name, p)
    os.mknod(jail / 'dev/null', stat.S_IFCHR | 0o666, os.makedev(1, 3))
    for directory, names, files in os.walk(jail):
        Path(directory).chmod(0o700 if Path(directory) == jail / 'evidence' else 0o755)
    (jail / 'dev/null').chmod(0o666)
    return identities

def run(mode, destination):
    assert mode in ('local', 'cleanup-probe')
    assert pwd.getpwnam('nobody').pw_uid == 65534 and pwd.getpwnam('nobody').pw_gid == 65534
    destination.mkdir(mode=0o700)
    workspace = Path(tempfile.mkdtemp(prefix='artifact-helius-qualification-'))
    jail = workspace / 'jail'; jail.mkdir()
    identity = prepare(jail)
    put(destination, 'jail-identity.json', identity)
    put(destination, 'harness-identity.json', {p.name: sha(p) for p in HERE.iterdir() if p.is_file()})
    outside = workspace / 'outside-canary'; outside.write_bytes(b'PUBLIC_SYNTHETIC_INACCESSIBILITY_CANARY'); outside.chmod(0o644)
    credential = workspace / 'synthetic-fd5'
    credential.write_text(json.dumps(dict(api_key='SYNTHETIC_QUALIFICATION_KEY_0001', ca=None, capability_id='helius-mainnet-query-v1'), sort_keys=True, indent=2) + '\n')
    credential.chmod(0o400); os.chown(credential, 65534, 65534)
    secret_fd = os.open(credential, os.O_RDONLY)
    os.dup2(secret_fd, 5, inheritable=True)
    if secret_fd != 5: os.close(secret_fd)
    fd = os.open(outside, os.O_RDONLY); os.dup2(fd, 1000, inheritable=True); os.close(fd)
    # Disposable already-connected local socket exercises a capability FD, not RPC.
    first, second = socket.socketpair(); os.dup2(first.fileno(), 1001, inheritable=True)
    limit = 2 if mode == 'cleanup-probe' else 60
    command = ['/usr/bin/unshare', '--mount', '--net', '--pid', '--fork', '--kill-child=KILL', '/usr/bin/python3', '-B', str(HERE / 'supervise.py'), '--child', str(jail), mode,
               os.readlink('/proc/self/ns/net'), os.readlink('/proc/self/ns/pid'), str(outside)]
    put(destination, 'command.json', dict(command=command, environment=ENV, external_deadline_seconds=limit, mode=mode,
        authorization='SYNTHETIC_LOOPBACK_ONLY_NO_SIGNING_OR_REAL_PROVIDER', accepted_R=R, new_identity_not_accepted_R=True))
    timed = False; start = time.monotonic()
    try:
        with (destination / 'diagnostics.txt').open('xb') as output:
            child_process = subprocess.Popen(command, cwd='/', env=ENV, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                             start_new_session=True, close_fds=True, pass_fds=(5, 1000, 1001))
            put(destination, 'process.json', dict(pid=child_process.pid, pgid=child_process.pid, start_monotonic=start))
            os.close(5); os.close(1000); os.close(1001); first.close(); second.close()
            try: code = child_process.wait(timeout=limit)
            except subprocess.TimeoutExpired:
                timed = True; os.killpg(child_process.pid, signal.SIGKILL); code = child_process.wait(timeout=5)
        isolation = json.loads((jail / 'evidence/isolation.json').read_bytes()) if (jail / 'evidence/isolation.json').exists() else None
        residual = []
        for p in Path('/proc').iterdir():
            if not p.name.isdigit(): continue
            try:
                if isolation and os.readlink(p / 'ns/pid') == isolation['pid_namespace']: residual.append(int(p.name))
            except OSError: pass
        shutil.copytree(jail / 'evidence', destination / 'evidence')
        for p in (destination / 'evidence').rglob('*'):
            if p.is_file(): p.chmod(0o600)
        result = dict(exit=code, timeout=timed, elapsed_seconds=time.monotonic()-start,
                      residual_pids=residual, isolation_established=isolation is not None,
                      escaped_descendant_created=(jail / 'evidence/escaped.json').exists(), real_provider_requests=0)
        assert not residual
    finally:
        # All namespace processes must be retired before deleting owned temp roots.
        shutil.rmtree(workspace)
    result['temporary_root_removed'] = not workspace.exists()
    put(destination, 'result.json', result)
    print(json.dumps(result))
    return 0 if isolation and not residual and ((mode == 'cleanup-probe' and timed and result['escaped_descendant_created']) or (mode == 'local' and code == 0)) else 1

if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) > 1 and sys.argv[1] == '--child':
        try: child(*sys.argv[2:])
        except Exception:
            print('QUALIFICATION_CONFINEMENT_STOP', flush=True); sys.exit(1)
    elif len(sys.argv) == 3 and sys.argv[1] in ('local', 'cleanup-probe'):
        sys.exit(run(sys.argv[1], Path(sys.argv[2])))
    else:
        print('QUALIFICATION_LIVE_DELIVERY_MAPPING_MISSING', flush=True); sys.exit(1)

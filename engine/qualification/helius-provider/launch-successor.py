"""Separate qualification launcher. No production launch gates are changed.

Private PID/mount namespaces contain an unprivileged fixed-target TCP broker,
private-net loopback TLS relay, and unprivileged worker. TLS terminates only in
accepted Node exchange and provider (synthetic local TLS server for local mode).
"""
import array
import ctypes
import encodings.idna
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('previous_supervisor', HERE / 'supervise.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
spec = importlib.util.spec_from_file_location('custody', HERE / 'custody.py')
custody = importlib.util.module_from_spec(spec); spec.loader.exec_module(custody)
spec = importlib.util.spec_from_file_location('deadline_supervisor', HERE / 'deadline-supervisor.py')
deadline = importlib.util.module_from_spec(spec); spec.loader.exec_module(deadline)
E = Path('/root/artifact-private-helius-provider-qualification-continuation')
ENDPOINT_HOST = 'mainnet.helius-rpc.com'

def close_except(keep):
    libc = ctypes.CDLL(None, use_errno=True)
    start = 3
    for fd in sorted(set(keep)):
        if fd >= start:
            if fd > start: assert libc.close_range(start, fd - 1, 0) == 0
            start = fd + 1
    assert libc.close_range(start, ctypes.c_uint(-1).value, 0) == 0

def drop(jail, keep, role):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    close_except(keep)
    for fd in (1000, 1001):
        try: os.fstat(fd); raise AssertionError('HIGH_FD_LEAK')
        except OSError: pass
    os.chroot(jail); os.chdir('/')
    libc = ctypes.CDLL(None, use_errno=True)
    for cap in range(41): assert libc.prctl(24, cap, 0, 0, 0) == 0
    os.setgroups([]); os.setgid(65534); os.setuid(65534)
    assert libc.prctl(38, 1, 0, 0, 0) == 0 and libc.prctl(4, 0, 0, 0, 0) == 0
    base.seccomp(libc)
    status = Path('/proc/self/status').read_text()
    caps = {k: int(next(s.split(':')[1] for s in status.splitlines() if s.startswith(k + ':')), 16)
            for k in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']}
    assert not any(caps.values()) and 'NoNewPrivs:\t1' in status
    assert not Path('/root/.openclaw').exists() and not Path('/var/lib/artifact-wiggles').exists()
    assert not Path('/root/artifact/trade-artifact').exists()
    assert not Path('/proc/1/root/root/.openclaw').exists()
    try: os.setuid(0); raise AssertionError('PRIVILEGE_REGAIN')
    except PermissionError: pass
    pending = role + '-isolation-pending.json'
    base.put(Path('/evidence'), pending, dict(uid=os.getuid(), gid=os.getgid(),
        groups=os.getgroups(), caps=caps, keep_fds=keep, no_new_privs=True, core_limit_zero=True,
        pid_namespace=os.readlink('/proc/self/ns/pid'), net_namespace=os.readlink('/proc/self/ns/net'),
        host_signer_state_absent=True, high_fds_closed=True, environment=base.ENV))
    # Publish exclusively only after complete file and directory fsync. Existence
    # of the final name must never expose a partially written isolation report.
    os.link('/evidence/' + pending, '/evidence/' + role + '-isolation.json')
    os.unlink('/evidence/' + pending)
    directory = os.open('/evidence', os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)

def bridge(channel, listener):
    for _ in range(29):
        client, _ = listener.accept()
        with client:
            channel.sendall(b'C')
            message, ancillary, flags, _ = channel.recvmsg(1, socket.CMSG_SPACE(4))
            assert message == b'S' and flags == 0
            descriptors = array.array('i')
            assert len(ancillary) == 1 and ancillary[0][:2] == (socket.SOL_SOCKET, socket.SCM_RIGHTS)
            descriptors.frombytes(ancillary[0][2]); assert len(descriptors) == 1
            with socket.socket(fileno=descriptors[0]) as upstream:
                pair = [client, upstream]
                while True:
                    readable, _, _ = select.select(pair, [], [], 5)
                    if not readable: raise RuntimeError('RELAY_TIMEOUT')
                    ended = False
                    for source in readable:
                        data = source.recv(16384)
                        if not data: ended = True; break
                        destination = upstream if source is client else client
                        destination.sendall(data)
                    if ended: break

def child(jail_name, mode, fixture_port, parent_pid_ns, parent_net_ns):
    jail = Path(jail_name)
    assert os.readlink('/proc/self/ns/pid') != parent_pid_ns
    subprocess.run(['/usr/bin/mount', '--make-rprivate', '/'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['/usr/bin/mount', '-t', 'proc', 'proc', str(jail / 'proc'), '-o', 'nosuid,nodev,noexec,hidepid=2'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    a, b = socket.socketpair()
    pid = os.fork()
    if pid == 0:
        a.close()
        libc = ctypes.CDLL(None, use_errno=True)
        assert libc.unshare(0x40000000 | 0x00020000) == 0  # NET + MOUNT
        subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        links = json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', 'link']))
        assert len(links) == 1 and links[0]['ifname'] == 'lo'
        assert os.readlink('/proc/self/ns/net') != parent_net_ns
        subprocess.run(['/usr/bin/mount', '--bind', str(jail / 'etc/worker-hosts'), str(jail / 'etc/hosts')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        listener = socket.socket(); listener.bind(('127.0.0.1', 443)); listener.listen(1)
        relay = os.fork()
        if relay == 0:
            drop(jail, [b.fileno(), listener.fileno()], 'relay')
            try: bridge(b, listener)
            except Exception: pass
            finally: os._exit(0)
        b.close(); listener.close()
        drop(jail, [5], 'worker')
        if mode == 'cleanup-probe':
            os.close(5)
            if os.fork() == 0:
                os.setsid(); base.put(Path('/evidence'), 'escaped.json', dict(pid=os.getpid(), sid=os.getsid(0)))
            while True: signal.pause()
        work_end = json.loads(Path('/outer-deadline.json').read_bytes())['work_deadline_monotonic']
        while not Path('/evidence/release.json').exists():
            assert time.monotonic() < work_end
            time.sleep(0.01)
        assert time.monotonic() < work_end
        if mode == 'worker-local':
            subprocess.run(['/bin/node', '--openssl-config=/accepted/engine/deployment/private-binding/openssl.cnf',
                '/harness/worker-fixture-input.mjs'], env=base.ENV, check=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        entry = '/harness/local-successor.mjs' if mode == 'local' else '/harness/worker-successor.mjs'
        assert time.monotonic() < work_end
        os.execve('/bin/node', ['/bin/node', '--openssl-config=/accepted/engine/deployment/private-binding/openssl.cnf', entry], base.ENV)
    b.close()
    drop(jail, [a.fileno()], 'broker')
    # Broker never receives FD-5 contents, URLs, HTTP requests or TLS plaintext.
    try:
        connections = 0
        while connections < 29:
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished: os._exit(os.waitstatus_to_exitcode(status))
            readable, _, _ = select.select([a], [], [], 0.05)
            if not readable: continue
            if a.recv(1) != b'C': break
            connections += 1
            host, port = ('127.0.0.1', int(fixture_port)) if mode in ('local', 'worker-local') else (ENDPOINT_HOST, 443)
            choices = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
            assert choices
            family, kind, proto, _, address = choices[0]  # exactly one address, no fallback
            with socket.socket(family, kind, proto) as connection:
                connection.settimeout(5); connection.connect(address)
                a.sendmsg([b'S'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [connection.fileno()]))])
        _, status = os.waitpid(pid, 0)
        os._exit(os.waitstatus_to_exitcode(status))
    except Exception:
        os._exit(1)

def prepare(jail, local):
    identities = base.prepare(jail)
    runtime = json.loads(base.RUNTIME.read_bytes())
    members = {m['resolved']: m for m in runtime['members']}
    copied = set()
    def copy(source, target):
        source = Path(source).resolve(strict=True)
        expected = members.get(str(source))
        if expected:
            assert base.sha(source) == expected['sha256'] and source.stat().st_size == expected['bytes']
        destination = jail / target.lstrip('/'); destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination); destination.chmod(0o444)
        identities.append(dict(source=str(source), jail_path=target, sha256=base.sha(source), accepted_R_member=expected is not None))
    # Only relative pure source closure. Dependency packages are separately identified
    # accepted runtime members, not credential stores or host mutable data.
    import re
    def closure(source):
        source = Path(source).resolve(strict=True)
        if source in copied: return
        copied.add(source)
        relative = source.relative_to(base.ROOT)
        copy(source, '/accepted/' + str(relative))
        for ref in re.findall(r"(?:from|import)\s*['\"](\.[^'\"]+)['\"]", source.read_text()):
            closure(source.parent / ref)
    for name in ['orca-message-boundary-v1.mjs', 'mandate-v1.mjs']:
        closure(base.ROOT / 'engine/src/verification-scope-v1-3/final-proof-agent' / name)
    closure(base.ROOT / 'engine/src/wallet-acquisition/solana-token-account-decoder-v1.mjs')
    closure(base.ROOT / 'engine/orca-readiness-sdk/index.mjs')
    for member in runtime['members']:
        if member['path'].startswith('dependency/'):
            copy(member['resolved'], '/accepted/' + str(Path(member['resolved']).relative_to(base.ROOT)))
    for path in HERE.glob('*.mjs'): copy(path, '/harness/' + path.name)
    (jail / 'etc').mkdir()
    (jail / 'etc/hosts').write_text('127.0.0.1 localhost\n')
    (jail / 'etc/worker-hosts').write_text('127.0.0.1 localhost mainnet.helius-rpc.com\n')
    (jail / 'etc/nsswitch.conf').write_text('hosts: files dns\n')
    # A single existing resolver, one attempt, no search list. Never select a new RPC.
    resolvers = [line.split()[1] for line in Path('/etc/resolv.conf').read_text().splitlines() if line.startswith('nameserver ')]
    assert resolvers
    (jail / 'etc/resolv.conf').write_text('nameserver ' + resolvers[0] + '\noptions attempts:1 timeout:1\n')
    for config in (jail / 'etc').iterdir(): config.chmod(0o444)
    if local:
        fixture = base.ROOT / 'engine/orca-readiness-sdk/fixtures/raw-rpc-3107-getMultipleAccounts.json'
        copy(fixture, '/fixtures/route.json')
    for directory, _, files in os.walk(jail):
        Path(directory).chmod(0o700 if Path(directory) == jail / 'evidence' else 0o755)
    return identities

def run(mode, destination, fixture_port=0, fixture_ca=None, fixture_case=None):
    started = time.monotonic()
    assert mode in ('local', 'worker-local', 'cleanup-probe', 'live')
    destination = Path(destination)
    def task(start, work_end, management_end, channel):
        return run_managed(mode, destination, fixture_port, fixture_ca, fixture_case,
            start, work_end, management_end, channel)
    def recover(context, result):
        workspace = context.get('workspace')
        if workspace is None:
            return dict(cleanup_confirmed=False)
        workspace = Path(workspace)
        evidence = workspace / 'jail/evidence'
        if evidence.exists():
            shutil.copytree(evidence, destination / 'evidence', dirs_exist_ok=True)
        if workspace.exists(): shutil.rmtree(workspace)
        return dict(cleanup_confirmed=not workspace.exists(), temporary_root_removed=not workspace.exists(), residual_pids=[])
    def persist(result):
        base.put(destination, 'outer-result.json', result)
    return deadline.supervise(task, recover, persist, mode, started, 2 if mode == 'cleanup-probe' else 60)

def run_managed(mode, destination, fixture_port, fixture_ca, fixture_case,
                start, work_end, management_end, channel):
    assert mode in ('local', 'worker-local', 'cleanup-probe', 'live')
    assert fixture_case is None or mode == 'worker-local'
    if mode == 'worker-local':
        assert 0 < fixture_port <= 65535 and fixture_ca is not None
        assert fixture_case in ('complete', 'input-extra', 'setup-contradiction', 'simulation-refusal')
    assert os.uname().machine == 'x86_64'
    destination = Path(destination); destination.mkdir(mode=0o700)
    workspace = Path(tempfile.mkdtemp(prefix='artifact-helius-successor-')); jail = workspace / 'jail'; jail.mkdir()
    deadline.send(channel, dict(kind='context', value=dict(workspace=str(workspace))))
    base.put(destination, 'outer-boundary.json', dict(start_monotonic=start,
        work_deadline_monotonic=work_end, management_deadline_monotonic=management_end))
    def in_time():
        if time.monotonic() >= work_end: raise TimeoutError('WHOLE_SESSION_DEADLINE')
    process = None; credential_fd = None; code = None; timed = False
    result = dict(mode=mode, released=False, real_provider_requests=0 if mode != 'live' else None)
    try:
        identities = prepare(jail, mode in ('local', 'worker-local'))
        in_time()
        base.put(jail, 'outer-deadline.json', dict(work_deadline_monotonic=work_end))
        (jail / 'outer-deadline.json').chmod(0o444)
        base.put(destination, 'jail-identity.json', identities)
        base.put(destination, 'harness-identity.json', {p.name: base.sha(p) for p in HERE.iterdir() if p.is_file()})
        if mode == 'worker-local':
            base.put(jail, 'fixture-case.json', dict(classification='SYNTHETIC_ONLY_NOT_PROVIDER', case=fixture_case))
            (jail / 'fixture-case.json').chmod(0o444)
            os.symlink('/evidence/synthetic-public-input.json', jail / 'public-input.json')
        in_time()
        if mode == 'live':
            # Evidence and frozen dispatch gates must exist before any credential read.
            assert (E / 'READY.json').is_file()
            ready = json.loads((E / 'READY.json').read_bytes())
            assert ready['classification'] == 'QUALIFICATION_ONLY_NO_AUTHORIZATION_OR_ELIGIBILITY'
            assert ready['setup_provenance_verified'] is True
            assert ready['local_checks_passed'] is True
            for path, expected in ready['files'].items(): assert base.sha(Path(path)) == expected
            base.put(E, 'single-session-reservation.json', dict(predecessor='/root/artifact-private-helius-provider-qualification/external-session', status='CONSUMED_POSSIBLY_DISPATCHED'))
            shutil.copyfile(E / 'public-input.json', jail / 'public-input.json'); (jail / 'public-input.json').chmod(0o444)
            in_time()
            credential_fd = custody.deliver(workspace, custody.read_authorized_key())
        else:
            credential_fd = custody.deliver(workspace, bytearray(b'SYNTHETIC_QUALIFICATION_KEY_0001'))
            if fixture_ca is not None:
                os.close(credential_fd)
                path = workspace / 'private-fd5'; path.chmod(0o600)
                path.write_text(json.dumps(dict(api_key='SYNTHETIC_QUALIFICATION_KEY_0001', ca=fixture_ca,
                    capability_id='helius-mainnet-query-v1'), sort_keys=True, indent=2) + '\n'); path.chmod(0o400)
                credential_fd = os.open(path, os.O_RDONLY)
        os.dup2(credential_fd, 5, inheritable=True)
        if credential_fd != 5: os.close(credential_fd)
        credential_fd = 5
        fd = os.open('/dev/null', os.O_RDONLY); os.dup2(fd, 1000, inheritable=True)
        if fd != 1000: os.close(fd)
        a, b = socket.socketpair(); os.dup2(a.fileno(), 1001, inheritable=True)
        limit = 2 if mode == 'cleanup-probe' else 60
        command = ['/usr/bin/unshare', '--mount', '--pid', '--fork', '--kill-child=KILL', '/usr/bin/python3', '-B',
            str(HERE / 'launch-successor.py'), '--child', str(jail), mode, str(fixture_port), os.readlink('/proc/self/ns/pid'), os.readlink('/proc/self/ns/net')]
        base.put(destination, 'command.json', dict(command=command, environment=base.ENV, deadline_seconds=limit, accepted_R=base.R))
        in_time()
        process = subprocess.Popen(command, env=base.ENV, cwd='/', stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True, pass_fds=(5, 1000, 1001))
        base.put(destination, 'process.json', dict(pid=process.pid, pgid=process.pid, start_monotonic=start, starttime=Path(f'/proc/{process.pid}/stat').read_text().split()[21]))
        os.close(5); credential_fd = None; os.close(1000); os.close(1001); a.close(); b.close()
        while process.poll() is None and time.monotonic() < work_end:
            ready_files = [jail / 'evidence' / (role + '-isolation.json') for role in ('broker', 'relay', 'worker')]
            if not result.get('isolation_verified') and all(p.is_file() for p in ready_files):
                roles = [json.loads(p.read_bytes()) for p in ready_files]
                assert all(r['uid'] == 65534 and not any(r['caps'].values()) for r in roles)
                assert roles[0]['pid_namespace'] == roles[1]['pid_namespace'] == roles[2]['pid_namespace']
                assert roles[0]['net_namespace'] != roles[2]['net_namespace'] == roles[1]['net_namespace']
                base.put(destination, 'isolation-before-release.json', roles)
                result['isolation_verified'] = True
                in_time()
                if mode != 'cleanup-probe':
                    deadline.send(channel, dict(kind='result', value=dict(released=None,
                        isolation_verified=True, release_status='RESERVED_POSSIBLY_RELEASED')))
                if mode != 'cleanup-probe': base.put(jail / 'evidence', 'release.json', dict(qualification_only=True))
                result['released'] = mode != 'cleanup-probe'
                deadline.send(channel, dict(kind='result', value=dict(released=result['released'],
                    isolation_verified=True)))
            time.sleep(0.01)
        if process.poll() is None:
            timed = True; os.killpg(process.pid, signal.SIGKILL)
        code = process.wait(timeout=max(0.001, management_end - time.monotonic()))
    except TimeoutError:
        timed = True; result['blocker'] = 'WHOLE_SESSION_DEADLINE'
    except custody.CustodyStop as error:
        result['blocker'] = str(error)
    except Exception:
        result['blocker'] = 'QUALIFICATION_LAUNCH_STOP'
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=max(0.001, management_end - time.monotonic()))
        if credential_fd is not None:
            try: os.close(credential_fd)
            except OSError: pass
        if (jail / 'evidence').exists(): shutil.copytree(jail / 'evidence', destination / 'evidence')
        namespace = None
        p = jail / 'evidence/worker-isolation.json'
        if p.exists(): namespace = json.loads(p.read_bytes())['pid_namespace']
        residual = []
        for p in Path('/proc').iterdir():
            if not p.name.isdigit(): continue
            try:
                if namespace and os.readlink(p / 'ns/pid') == namespace: residual.append(int(p.name))
            except OSError: pass
        result.update(exit=code, timeout=timed, residual_pids=residual, elapsed_seconds=time.monotonic() - start)
        if not residual: shutil.rmtree(workspace)
        result['temporary_root_removed'] = not workspace.exists()
        base.put(destination, 'result.json', result)
    return result

if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) == 7 and sys.argv[1] == '--child':
        try: child(*sys.argv[2:])
        except Exception: os._exit(1)
    elif len(sys.argv) == 3 and sys.argv[1] in ('live', 'cleanup-probe'):
        print(json.dumps(run(sys.argv[1], sys.argv[2])))
    else: print('QUALIFICATION_LAUNCH_ARGUMENT_STOP'); sys.exit(1)

"""Fixed namespace-init stage. Independently gated; never a production bypass."""
import importlib.util
import os
from pathlib import Path
import stat
import sys

spec = importlib.util.spec_from_file_location('host_v2', Path(__file__).with_name('host-launch-v2.py'))
assert spec is not None and spec.loader is not None
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def namespace_body():
    host.require_activation()
    if len(sys.argv) != 1 or os.getuid() != 0 or os.getpid() != 1:
        raise RuntimeError('HOST_NAMESPACE_STOP')
    # Source-fixed external streams, supplied only by trusted administration:
    # 20 acquisition signed envelope; 21 disposal signed envelope; 22 controller
    # challenge/results; 23 human signed envelope; 24 human context/ack; 25 final.
    identities = set()
    for fd in range(20, 26):
        st = os.fstat(fd)
        mode = host.fcntl.fcntl(fd, host.fcntl.F_GETFL) & os.O_ACCMODE
        expected = os.O_RDONLY if fd in (20, 21, 23) else os.O_WRONLY
        if not stat.S_ISFIFO(st.st_mode) or mode != expected or (st.st_dev, st.st_ino) in identities:
            raise RuntimeError('HOST_CUSTODY_STOP')
        identities.add((st.st_dev, st.st_ino))
    host.close_except({fd: fd for fd in range(20, 26)})
    null = os.open('/dev/null', os.O_RDWR | os.O_CLOEXEC)
    config = host.fixed_file(host.CUSTODY + '/public-binding.json', 0, 262144, False)
    release = host.fixed_file(host.CUSTODY + '/executable-release.json', 0, 33554432, False)
    credential = host.fixed_file(host.CUSTODY + '/provider-capability.json', host.UIDS['worker'], 73728, True)
    worker, controller, human, final, owned = host.pipes()
    # FD15's only consumer is the independent final-disposition custodian.
    worker.update({3:config, 4:release, 5:credential, 15:25})
    controller.update({3:config, 16:20, 17:21, 18:22})
    human.update({3:config, 16:23, 17:24})
    roles = [('worker', 'worker.mjs', worker), ('controller', 'control-client-v2.mjs', controller),
             ('human', 'human-client-v2.mjs', human)]
    pids = []
    if host.LIBC.prctl(36, 1, 0, 0, 0):
        raise RuntimeError('HOST_SUBREAPER_STOP')
    try:
        for role, script, mapping in roles:
            mapping.update({0:null, 1:null, 2:null})  # zero-byte bounded diagnostics
            pid = os.fork()
            if pid == 0:
                try:
                    host.prepare_child(mapping, host.UIDS[role], host.RELEASE)
                    os.execve(host.NODE, [host.NODE, '--openssl-config=' + host.HERE + 'openssl.cnf',
                                        host.HERE + script], host.ENV)
                except BaseException:
                    os._exit(1)
            pids.append(pid)
        # Absolutely no peer remains open in the supervisor: EOF/EPIPE is real.
        host.close_except({})
        result = host.supervise(pids, 600)
        return 0 if (result['clean'] and not result['timed'] and len(result['status']) == 3
                     and all(code == 0 for code in result['status'].values())) else 1
    finally:
        # Leaving PID namespace init kills all remaining descendants in kernel,
        # including setsid/double-fork children and unavailable /proc descendants.
        pass


def main():
    try:
        host.require_activation()
        return namespace_body()
    except BaseException:
        sys.stderr.write('PRIVATE_HOST_V2_DISABLED_NO_EFFECTS\n')
        return 1


if __name__ == '__main__':
    sys.exit(main())

"""Fixed production host candidate. No activation switch or private access at entry."""
import sys
import ctypes
import fcntl
import json
import os
from pathlib import Path
import resource
import signal
import stat
import subprocess
import time

RELEASE = '/opt/artifact/release'
CUSTODY = '/etc/artifact-wiggles'
HERE = RELEASE + '/engine/deployment/private-binding/'
NODE = '/usr/bin/node'
ENV = dict(PATH='/usr/bin:/bin', HOME='/nonexistent', USERPROFILE='/nonexistent',
           LANG='C.UTF-8', LC_ALL='C.UTF-8', TZ='UTC')
UIDS = dict(worker=62001, controller=62002, human=62003)
LIBC = ctypes.CDLL(None, use_errno=True)


def require_activation():
    raise RuntimeError('PRIVATE_HOST_V2_DISABLED_NO_EFFECTS')


def bind_parent_death(expected_parent):
    if LIBC.prctl(1, signal.SIGKILL, 0, 0, 0):
        raise OSError('HOST_PARENT_DEATH_STOP')
    if os.getppid() != expected_parent:
        os.kill(os.getpid(), signal.SIGKILL)


def close_except(mapping):
    """Duplicate high first; close even FDs beyond the current RLIMIT_NOFILE."""
    saved = {dst: fcntl.fcntl(src, fcntl.F_DUPFD_CLOEXEC, 64)
             for dst, src in mapping.items()}
    for dst, src in saved.items():
        os.dup2(src, dst, inheritable=True)
    keep = sorted(mapping)
    first = 0
    for fd in keep + [0xffffffff]:
        if first < fd and LIBC.close_range(first, fd - 1, 0):
            raise OSError(ctypes.get_errno(), 'close_range')
        first = fd + 1


def pipes():
    worker, controller, human, owned = {}, {}, {}, []
    for fd in range(6, 16):
        r, w = os.pipe2(os.O_CLOEXEC)
        owned.extend([r, w])
        worker[fd], peer = (r, w) if fd in (6, 9, 12) else (w, r)
        if fd <= 11:
            controller[fd] = peer
        elif fd <= 14:
            human[fd] = peer
        else:
            final = peer
    return worker, controller, human, final, owned


def prepare_child(mapping, uid, cwd):
    close_except(mapping)
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_FSIZE, (67108864, 67108864))
    resource.setrlimit(resource.RLIMIT_CPU, (610, 610))
    # Privilege loss is mandatory, never a same-UID production fallback.
    os.setgroups([])
    os.setresgid(uid, uid, uid)
    os.setresuid(uid, uid, uid)
    if LIBC.prctl(38, 1, 0, 0, 0) or LIBC.prctl(4, 0, 0, 0, 0):
        raise OSError('prctl')
    os.chdir(cwd)


def descendants():
    # /proc may be the outer mount (qualify.py intentionally does not remount).
    # Traverse proc-visible IDs, signal IDs from this namespace's NSpid column.
    own_status = Path('/proc/self/status').read_text().splitlines()
    column = len(next(v for v in own_status if v.startswith('NSpid:')).split()) - 1
    result, seen, todo = set(), set(), [int(os.readlink('/proc/self'))]
    while todo:
        parent = todo.pop()
        try:
            children = Path(f'/proc/{parent}/task/{parent}/children').read_text().split()
        except FileNotFoundError:
            continue
        for text in children:
            pid = int(text)
            if pid not in seen:
                seen.add(pid)
                todo.append(pid)
                try:
                    lines = Path(f'/proc/{pid}/status').read_text().splitlines()
                    result.add(int(next(v for v in lines if v.startswith('NSpid:')).split()[column]))
                except FileNotFoundError:
                    pass
    return result


def supervise(pids, seconds):
    """Finite local reap; production additionally has an external PID-ns kill."""
    deadline = time.monotonic() + seconds
    status = {}
    while len(status) < len(pids) and time.monotonic() < deadline:
        try:
            pid, code = os.waitpid(-1, os.WNOHANG)
            if pid in pids:
                status[pid] = code
                if code:
                    break
        except ChildProcessError:
            break
        time.sleep(.005)
    timed = time.monotonic() >= deadline
    # Subreaper catches double-fork/setsid descendants; no process-group-only claim.
    cleanup_end = time.monotonic() + 1
    while time.monotonic() < cleanup_end:
        remaining = descendants()
        for pid in remaining:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            while True:
                pid, code = os.waitpid(-1, os.WNOHANG)
                if not pid:
                    break
                if pid in pids:
                    status[pid] = code
        except ChildProcessError:
            return dict(timed=timed, clean=True, status=status)
        time.sleep(.005)
    return dict(timed=timed, clean=not descendants(), status=status)


def fixed_production_host():
    require_activation()
    if len(sys.argv) != 1 or os.getuid() != 0:
        raise RuntimeError('HOST_STOP')
    null = os.open('/dev/null', os.O_RDWR | os.O_CLOEXEC)
    close_except({0:null, 1:null, 2:null, **{fd:fd for fd in range(20, 26)}})
    fd = fixed_file(CUSTODY + '/public-binding.json', 0, 262144, False)
    try:
        public = json.loads(os.read(fd, 262145))
    finally:
        os.close(fd)
    deadline = time.monotonic() + episode_seconds(public, time.time())
    # Namespace init death kills even descendants that changed session/group.
    command = ['/usr/bin/unshare', '--pid', '--fork', '--kill-child=KILL',
               '/usr/bin/python3', '-I', '-S', HERE + 'host-namespace-v2.py']
    parent = os.getpid()
    child = subprocess.Popen(command, cwd=RELEASE, env=ENV, close_fds=True,
                             pass_fds=tuple(range(20, 26)), start_new_session=True,
                             preexec_fn=lambda: bind_parent_death(parent))
    try:
        close_except({0:0, 1:1, 2:2})
        return child.wait(timeout=max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        return 124
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def episode_seconds(public, now):
    milliseconds = public['episode_timeout_ms']
    end = public['runtime']['deadline_unix_seconds']
    if type(milliseconds) is not int or not 1 <= milliseconds <= 600000 or type(end) is not int or end <= now:
        raise ValueError('HOST_DEADLINE_STOP')
    return min(milliseconds / 1000, end - now)


def fixed_file(path, owner, maximum, private):
    for parent in Path(path).parents:
        st = parent.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('HOST_PATH_STOP')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    st = os.fstat(fd)
    if (not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != owner
            or st.st_mode & (0o077 if private else 0o022) or not 0 < st.st_size <= maximum):
        os.close(fd)
        raise RuntimeError('HOST_FILE_STOP')
    return fd


def main():
    # Review-only activation patch lives outside executable source. This branch
    # must remain before path checks, credential opens, state access and forks.
    sys.stderr.write('PRIVATE_HOST_V2_DISABLED_NO_EFFECTS\n')
    return 1


if __name__ == '__main__':
    sys.exit(main())

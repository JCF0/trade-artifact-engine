"""Qualification-only external deadline owner. No credential or provider operations.

All filesystem work runs in killable owned children, never in the timer loop.
PID namespace init retirement is observed through pidfds; SIGKILL is a request,
not proof of retirement of uninterruptible kernel work. No blocking waits on exit.
"""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import time


def send(channel, value):
    payload = json.dumps(value).encode()
    assert len(payload) < 60000
    channel.send(payload)


def dead(fd):
    return fd is not None and bool(select.select([fd], [], [], 0)[0])


def kill(fd):
    if fd is not None:
        try: signal.pidfd_send_signal(fd, signal.SIGKILL)
        except ProcessLookupError: pass


def domain(callback):
    """Fork a gated PID/mount namespace. Register its init before any task work."""
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    # The custodian owns FD 5. Do not let delivery overwrite supervisory IPC.
    b2 = socket.socket(fileno=fcntl.fcntl(b.fileno(), fcntl.F_DUPFD_CLOEXEC, 200))
    b.close(); b = b2
    pid = os.fork()
    if pid == 0:
        a.close()
        try:
            os.setsid()
            libc = ctypes.CDLL(None, use_errno=True)
            # Remove inherited fixture-server sockets and other ambient FDs.
            keep = b.fileno()
            assert libc.close_range(3, keep - 1, 0) == 0
            assert libc.close_range(keep + 1, ctypes.c_uint(-1).value, 0) == 0
            assert libc.unshare(0x20000000 | 0x00020000) == 0
            assert libc.mount(None, b'/', None, (1 << 18) | (1 << 14), None) == 0
            child = os.fork()
            if child == 0:
                assert b.recv(16) == b'GO'
                # /proc must use the management namespace's PIDs, not host PIDs.
                assert libc.mount(b'proc', b'/proc', b'proc', 2 | 4 | 8, None) == 0
                callback(b)
                os._exit(0)
            send(b, dict(kind='domain', pid=child))
            b.close()
            _, status = os.waitpid(child, 0)
            os._exit(os.waitstatus_to_exitcode(status) & 255)
        except BaseException:
            os._exit(1)
    b.close(); a.setblocking(False)
    return dict(pid=pid, owner_fd=os.pidfd_open(pid), init_fd=None, channel=a, done=False)


def poll(d, on_message, allow_start):
    if d['done']: return
    if select.select([d['channel']], [], [], 0)[0]:
        payload = d['channel'].recv(65536)
        if payload:
            value = json.loads(payload)
            if value.get('kind') == 'domain':
                d['init_fd'] = os.pidfd_open(value['pid'])
                if allow_start: d['channel'].send(b'GO')
                else: kill(d['init_fd'])
            else: on_message(value)
        else: d['done'] = True


def stop(d):
    kill(d['init_fd'])
    # Wrapper and an as-yet unregistered init share this owned process group.
    # The leader is our unreaped child: its PID cannot be reused yet. Include a
    # gated init even if the wrapper died before its registration packet arrived.
    try: os.killpg(d['pid'], signal.SIGKILL)
    except ProcessLookupError: pass
    kill(d['owner_fd'])


def supervise(task, recover, persist, mode, started, limit):
    end = started + limit
    reserve = min(5.0, limit / 4)
    work_end = end - 2 * reserve
    management_end = end - reserve
    result = dict(mode=mode, released=False, exit=None, timeout=True,
        cleanup_confirmed=False, temporary_root_removed=False, residual_pids=None,
        real_provider_requests=0 if mode != 'live' else None)
    context = {}
    domains = []
    def messages(value):
        if value['kind'] == 'context': context.update(value['value'])
        elif value['kind'] == 'result': result.update(value['value'])
    try:
        d = domain(lambda ch: send(ch, dict(kind='result', value=task(started, work_end, management_end, ch))))
        domains.append(d)
        while time.monotonic() < management_end:
            poll(d, messages, time.monotonic() < work_end)
            if dead(d['owner_fd']) and d['done']: break
            time.sleep(min(0.01, max(0, management_end - time.monotonic())))
        interrupted = not dead(d['owner_fd']) or not d['done']
        if interrupted:
            result['timeout'] = True
            result['blocker'] = 'WHOLE_SESSION_DEADLINE'
        stop(d)
        while time.monotonic() < end - reserve / 2 and not dead(d['init_fd']):
            poll(d, messages, False)
            if d['init_fd'] is None and dead(d['owner_fd']): break
            time.sleep(0.005)
        retired = dead(d['init_fd'])
        result['namespace_retirement_confirmed'] = retired
        result['outer_limit_seconds'] = limit
        result['outer_started_monotonic'] = started
        result['outer_deadline_monotonic'] = end
        result['work_deadline_monotonic'] = work_end
        result['management_deadline_monotonic'] = management_end
        result['partial_evidence_location'] = context.get('workspace')
        # Recovery and report persistence have ONLY the original remaining time.
        # Unconfirmed namespace retirement forbids deleting its mutable workspace.
        def finish(ch):
            if retired:
                result.update(recover(context, result))
            else:
                result['cleanup_confirmed'] = False
            result['elapsed_seconds'] = time.monotonic() - started
            persist(result)
            send(ch, dict(kind='result', value=dict(result, outer_record_retained=True)))
        if time.monotonic() < end - 0.05:
            f = domain(finish); domains.append(f)
            while time.monotonic() < end - 0.02:
                poll(f, messages, time.monotonic() < end - 0.05)
                if dead(f['owner_fd']) and f['done']: break
                time.sleep(min(0.005, max(0, end - 0.02 - time.monotonic())))
            stop(f)
            while time.monotonic() < end and not dead(f['init_fd']):
                poll(f, messages, False)
                if f['init_fd'] is None and dead(f['owner_fd']): break
                time.sleep(min(0.001, max(0, end - time.monotonic())))
        result['supervisor_domains_retired'] = all(dead(x['init_fd']) and dead(x['owner_fd']) for x in domains)
        result.setdefault('outer_record_retained', False)
        if not result['outer_record_retained'] or not result['supervisor_domains_retired']:
            result['timeout'] = True
            result['cleanup_confirmed'] = False
            result['blocker'] = 'OUTER_RETENTION_OR_CLEANUP_UNCONFIRMED'
        result['elapsed_seconds'] = time.monotonic() - started
        return result
    finally:
        for d in domains:
            stop(d)
            # WNOHANG only: never turn a timeout into an unlimited wait.
            try: os.waitpid(d['pid'], os.WNOHANG)
            except ChildProcessError: pass
            d['channel'].close()
            for key in ('owner_fd', 'init_fd'):
                if d[key] is not None: os.close(d[key])

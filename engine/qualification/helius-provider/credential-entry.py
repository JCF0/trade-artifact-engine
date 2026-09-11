"""Operator-only hidden terminal entry. No RPC, environment credential or overwrite."""
import ctypes
import getpass
import importlib.util
import os
from pathlib import Path
import re
import resource
import sys
import warnings

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('artifact_custody', HERE / 'artifact-custody.py')
assert spec is not None and spec.loader is not None
custody = importlib.util.module_from_spec(spec); spec.loader.exec_module(custody)
PENDING = custody.NAME + '.pending'


def _require_absent(directory_fd):
    for name in (custody.NAME, PENDING):
        try: os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError: continue
        raise custody.CustodyStop('CREDENTIAL_ENTRY_STOP')


def _store(directory_fd, key):
    """Write and sync privately, then publish by an exclusive hard link.

    A retained pending name blocks rerun after prepublication failure. After the
    link, an error can mean publication completed: never remove the final name
    or infer successful entry from its existence/parsing. Operator confirmation
    of this invocation's success marker AND exit zero remains mandatory.
    """
    fd = None
    try:
        custody.base.require(re.fullmatch(rb'[A-Za-z0-9._~-]{16,4096}', key) is not None,
                             'CREDENTIAL_VALUE_UNSUITABLE')
        _require_absent(directory_fd)
        fd = os.open(PENDING, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory_fd)
        os.fchown(fd, 0, 0); os.fchmod(fd, 0o600)
        payload = bytearray(b'HELIUS_API_KEY=') + key + b'\n'
        try:
            offset = 0
            while offset < len(payload):
                n = os.write(fd, payload[offset:])
                custody.base.require(n > 0, 'CREDENTIAL_ENTRY_STOP')
                offset += n
            os.fsync(fd); os.fsync(directory_fd)
            # Same exclusive publication mechanism as isolation reports: no
            # partial payload is ever visible under the final credential name.
            os.link(PENDING, custody.NAME, src_dir_fd=directory_fd,
                    dst_dir_fd=directory_fd, follow_symlinks=False)
            # Normal publication housekeeping only; exceptions do NO cleanup.
            os.unlink(PENDING, dir_fd=directory_fd)
            os.fsync(directory_fd)
        finally: payload[:] = b'\0' * len(payload)
    except Exception:
        # Preserve failed/uncertain state for explicit operator recovery. A
        # published file may be parseable even when this invocation fails.
        raise custody.CustodyStop('CREDENTIAL_ENTRY_STOP') from None
    finally:
        if fd is not None: os.close(fd)
        key[:] = b'\0' * len(key)


def main():
    directory = None
    key = bytearray()
    try:
        custody.base.require(os.geteuid() == 0, 'CREDENTIAL_ENTRY_STOP')
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        custody.base.require(ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0, 'CREDENTIAL_ENTRY_STOP')
        os.umask(0o077)
        # Refuse pipe/stdin fallback before reading any input or creating a directory.
        with open('/dev/tty', 'w') as tty:
            custody.base.require(os.isatty(tty.fileno()), 'CREDENTIAL_ENTRY_STOP')
            directory = custody._directory(create=True)
            _require_absent(directory)
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                first = getpass.getpass('New Helius key: ', stream=tty)
                second = getpass.getpass('Confirm Helius key: ', stream=tty)
            custody.base.require(first == second, 'CREDENTIAL_ENTRY_STOP')
            key.extend(first.encode('ascii'))
            del first, second
            _store(directory, key)
        print('ARTIFACT_CREDENTIAL_ENTRY_PUBLISHED: no request sent.', flush=True)
        return 0
    except (Exception, KeyboardInterrupt):
        print('CREDENTIAL_ENTRY_UNCONFIRMED: do not use, delete, overwrite or retry; explicit recovery required.', file=sys.stderr)
        return 1
    finally:
        key[:] = b'\0' * len(key)
        if directory is not None: os.close(directory)


if __name__ == '__main__':
    if len(sys.argv) != 1:
        print('CREDENTIAL_ENTRY_STOP: arguments are not accepted.', file=sys.stderr)
        sys.exit(1)
    sys.exit(main())

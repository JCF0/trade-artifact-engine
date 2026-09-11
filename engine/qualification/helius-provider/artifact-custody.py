"""Dedicated qualification credential custody; no environment override or live entry.

The diagnostic launcher explicitly imports this module. Historical frozen
launchers and their consumed reservations remain unchanged.
"""
import importlib.util
import os
from pathlib import Path
import stat

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('original_custody', HERE / 'custody.py')
assert spec is not None and spec.loader is not None
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
CustodyStop = base.CustodyStop
SOURCE = '/root/.artifact-qualification/helius.env'
NAME = 'helius.env'
deliver = base.deliver


def _directory(create=False):
    """Fixed no-follow traversal; optional creation belongs only to operator entry."""
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in ('root', '.artifact-qualification'):
            if create and component == '.artifact-qualification':
                try:
                    os.mkdir(component, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError: pass
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
            st = os.fstat(fd)
            base.require(st.st_uid == 0 and st.st_gid == 0 and not st.st_mode & 0o022,
                         'CREDENTIAL_PARENT_UNSUITABLE')
            if component == '.artifact-qualification':
                base.require(stat.S_IMODE(st.st_mode) == 0o700, 'CREDENTIAL_PARENT_UNSUITABLE')
        result = fd; fd = None
        return result
    except CustodyStop:
        raise
    except FileNotFoundError:
        raise CustodyStop('CREDENTIAL_SOURCE_MISSING') from None
    except Exception:
        raise CustodyStop('CREDENTIAL_SOURCE_ACCESS_REFUSED') from None
    finally:
        if fd is not None: os.close(fd)


def read_authorized_key():
    """Only the dedicated named assignment; never consult environment or old source."""
    fd = _directory()
    try: return base._read_named(fd, NAME, 0)
    finally: os.close(fd)

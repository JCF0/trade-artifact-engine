"""Qualification-only custody. The production source is fixed; errors contain no data."""
import json
import os
from pathlib import Path
import re
import stat

SOURCE = '/root/.openclaw/.env'

class CustodyStop(Exception):
    pass

def require(condition, code):
    if not condition:
        raise CustodyStop(code)

def _read_named(directory_fd, name, owner):
    fd = None
    raw = bytearray()
    try:
        before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == owner and before.st_gid == owner
                and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1,
                'CREDENTIAL_SOURCE_UNSUITABLE')
        require(0 < before.st_size <= 1048576, 'CREDENTIAL_SOURCE_SIZE')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
        st = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink,
                              s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(identity(st) == identity(before), 'CREDENTIAL_SOURCE_CHANGED')
        while len(raw) <= before.st_size:
            part = os.read(fd, min(65536, before.st_size + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        require(len(raw) == before.st_size and identity(os.fstat(fd)) == identity(before)
                and identity(os.stat(name, dir_fd=directory_fd, follow_symlinks=False)) == identity(before),
                'CREDENTIAL_SOURCE_CHANGED')
        matches = []
        # Ignore other assignments without decoding or evaluating them. Accept only
        # one literal named assignment. No expansion, commands, escapes or multiline.
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith(b'#'):
                continue
            if line.startswith(b'export '):
                line = line[7:].lstrip()
            if re.match(rb'HELIUS_API_KEY(?:\s|=|$)', line):
                m = re.fullmatch(rb'HELIUS_API_KEY\s*=\s*([A-Za-z0-9._~-]{16,4096}|\'[A-Za-z0-9._~-]{16,4096}\'|"[A-Za-z0-9._~-]{16,4096}")\s*', line)
                if m is None:
                    raise CustodyStop('CREDENTIAL_NAMED_ASSIGNMENT_UNSUPPORTED')
                matches.append(m.group(1).strip(b'\'"'))
        require(len(matches) == 1, 'CREDENTIAL_NAMED_ASSIGNMENT_MISSING' if not matches else 'CREDENTIAL_NAMED_ASSIGNMENT_AMBIGUOUS')
        return bytearray(matches[0])
    except CustodyStop:
        raise
    except FileNotFoundError:
        raise CustodyStop('CREDENTIAL_SOURCE_MISSING') from None
    except Exception:
        raise CustodyStop('CREDENTIAL_SOURCE_ACCESS_REFUSED') from None
    finally:
        raw[:] = b'\0' * len(raw)
        if fd is not None:
            os.close(fd)

def read_authorized_key():
    """Traverse only the exact source; no unexpected directory symlinks."""
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in ('root', '.openclaw'):
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = next_fd
            st = os.fstat(fd)
            require(st.st_uid == 0 and not st.st_mode & 0o022, 'CREDENTIAL_PARENT_UNSUITABLE')
        return _read_named(fd, '.env', 0)
    except CustodyStop:
        raise
    except FileNotFoundError:
        raise CustodyStop('CREDENTIAL_SOURCE_MISSING') from None
    except Exception:
        raise CustodyStop('CREDENTIAL_SOURCE_ACCESS_REFUSED') from None
    finally:
        os.close(fd)

def deliver(workspace, key):
    """Single-link private canonical file; caller closes FD and removes owned root."""
    path = Path(workspace) / 'private-fd5'
    payload = bytearray()
    try:
        require(re.fullmatch(rb'[A-Za-z0-9._~-]{16,4096}', key) is not None, 'CREDENTIAL_VALUE_UNSUITABLE')
        payload.extend((json.dumps(dict(api_key=key.decode('ascii'), ca=None,
            capability_id='helius-mainnet-query-v1'), sort_keys=True, indent=2) + '\n').encode())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            offset = 0
            while offset < len(payload):
                offset += os.write(fd, payload[offset:])
            os.fsync(fd); os.fchown(fd, 65534, 65534); os.fchmod(fd, 0o400)
        finally:
            os.close(fd)
        return os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except CustodyStop:
        raise
    except Exception:
        raise CustodyStop('CREDENTIAL_DELIVERY_REFUSED') from None
    finally:
        key[:] = b'\0' * len(key)
        payload[:] = b'\0' * len(payload)

"""Fixed fresh-process verifier launcher: public release and package identities only."""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import resource
import socket
import sys

HERE = Path(__file__).resolve().parent


def close_inherited_descriptors():
    # Linux close_range closes the complete unsigned-FD domain, including open
    # descriptors above subsequently lowered soft/hard RLIMIT_NOFILE values.
    # Flags 0 closes now, not merely on exec. Only custodian-owned 0, 1, 2 survive.
    # Missing libc/kernel support or a denied syscall must stop, never fall back
    # to a resource-limit-derived range or an arbitrary descriptor ceiling.
    close_range = ctypes.CDLL(None, use_errno=True).close_range
    close_range.argtypes = [ctypes.c_uint, ctypes.c_uint, ctypes.c_int]
    close_range.restype = ctypes.c_int
    if close_range(3, ctypes.c_uint(-1).value, 0) != 0:
        raise OSError(ctypes.get_errno(), 'VERIFIER_FD_CLOSURE_FAILED')


def main():
    if len(sys.argv) != 6:
        raise RuntimeError('VERIFIER_ARGUMENTS_INVALID')
    inventory_path, release_hash, root, manifest_hash, kind = sys.argv[1:]
    data = Path(inventory_path).read_bytes()
    if len(data) > 33554432 or hashlib.sha256(data).hexdigest() != release_hash:
        raise RuntimeError('VERIFIER_RELEASE_INVALID')
    release = json.loads(data)
    if release['version'] != 'artifact_private_executable_release_v1':
        raise RuntimeError('VERIFIER_RELEASE_INVALID')
    allowed = set(); node = None
    for m in release['members']:
        p = Path(m['resolved'])
        if str(p.resolve()) != m['resolved'] or p.stat().st_size != m['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest() != m['sha256']:
            raise RuntimeError('VERIFIER_RELEASE_CHANGED')
        allowed.add(str(p))
        if m['path'] == 'runtime/node': node = str(p)
    if not node or str(HERE / 'verify.mjs') not in allowed or str(HERE / 'verifier-sandbox.py') not in allowed:
        raise RuntimeError('VERIFIER_CLOSURE_INCOMPLETE')
    package = Path(root)
    if not package.is_absolute() or str(package.resolve()) != root:
        raise RuntimeError('VERIFIER_PACKAGE_INVALID')
    members = list(package.iterdir())
    if len(members) > 513:
        raise RuntimeError('VERIFIER_PACKAGE_INVALID')
    size = 0
    for p in members:
        st = p.lstat(); size += st.st_size
        if not p.is_file() or p.is_symlink() or st.st_nlink != 1 or st.st_size > 8388608 or size > 67108864:
            raise RuntimeError('VERIFIER_PACKAGE_INVALID')
        allowed.add(str(p))
    # Package directory enumeration is not needed by the replay loader? It is:
    # grant read-directory only, never any creation/removal or write permission.
    spec = importlib.util.spec_from_file_location('private_sandbox', HERE / 'verifier-sandbox.py')
    sandbox = importlib.util.module_from_spec(spec); spec.loader.exec_module(sandbox)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    close_inherited_descriptors()
    abi = sandbox.restrict(allowed, node, [root])
    try:
        socket.socket()
        raise RuntimeError('VERIFIER_NETWORK_NOT_DENIED')
    except PermissionError:
        pass
    try:
        fd = os.open(str(package / 'manifest.json'), os.O_WRONLY)
        os.close(fd)
        raise RuntimeError('VERIFIER_WRITES_NOT_DENIED')
    except PermissionError:
        pass
    print('VERIFIER_ISOLATION ' + json.dumps(dict(landlock_abi=abi, network='SECCOMP_DENIED',
          authority='NO_READ_OR_WRITE_GRANT', package='READ_ONLY', core_limit=0)), file=sys.stderr, flush=True)
    request = json.dumps(dict(root=root, expected_manifest_sha256=manifest_hash, expected_evidence_kind=kind), separators=(',', ':'))
    os.chdir('/tmp')
    os.execve(node, [node, '--openssl-config=' + str(HERE / 'openssl.cnf'), str(HERE / 'verify.mjs'), request], {})


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('PRIVATE_VERIFIER_STOPPED', file=sys.stderr)
        sys.exit(1)

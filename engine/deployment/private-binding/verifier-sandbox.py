"""Linux x86-64 fail-closed verifier confinement. No host policy changes."""
import ctypes
import errno
import os
import platform


def restrict(read_files, executable, read_directories):
    if platform.machine() != 'x86_64':
        raise RuntimeError('VERIFIER_UNSUPPORTED_HOST')
    libc = ctypes.CDLL(None, use_errno=True)
    def checked(value):
        if value < 0:
            raise OSError(ctypes.get_errno(), 'VERIFIER_CONFINEMENT_FAILED')
        return value
    checked(libc.prctl(38, 1, 0, 0, 0))  # no_new_privs
    abi = checked(libc.syscall(444, 0, 0, 1))
    if abi < 3:
        raise RuntimeError('VERIFIER_LANDLOCK_ABI_REQUIRED')
    class Ruleset(ctypes.Structure):
        _fields_ = [('access', ctypes.c_uint64)]
    class PathRule(ctypes.Structure):
        _pack_ = 1
        _fields_ = [('access', ctypes.c_uint64), ('parent', ctypes.c_int32)]
    rules = Ruleset((1 << 15) - 1)
    fd = checked(libc.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0))
    try:
        for path in sorted(set(read_files) | {executable}):
            handle = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathRule(4 | (1 if path == executable or path.endswith('.so') or '.so.' in path else 0), handle)
                checked(libc.syscall(445, fd, 1, ctypes.byref(rule), 0))
            finally:
                os.close(handle)
        for path in sorted(set(read_directories)):
            handle = os.open(path, os.O_PATH | os.O_CLOEXEC | os.O_DIRECTORY)
            try:
                rule = PathRule(8, handle)
                checked(libc.syscall(445, fd, 1, ctypes.byref(rule), 0))
            finally:
                os.close(handle)
        checked(libc.syscall(446, fd, 0))
    finally:
        os.close(fd)
    # Classic seccomp BPF: architecture guard; deny networking/ptrace/process
    # memory IO. No inherited network descriptors are passed by the launcher.
    class Filter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]
    class Program(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ushort), ('filters', ctypes.POINTER(Filter))]
    entries = [Filter(0x20, 0, 0, 4), Filter(0x15, 1, 0, 0xc000003e), Filter(0x06, 0, 0, 0x80000000), Filter(0x20, 0, 0, 0)]
    # Reject x32 syscall ABI as well as the native socket family.
    entries += [Filter(0x45, 0, 1, 0x40000000), Filter(0x06, 0, 0, 0x80000000)]
    for number in [41, 42, 43, 44, 45, 46, 47, 49, 50, 53, 101, 288, 299, 307, 310, 311, 425, 426, 427]:
        entries += [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x50000 | errno.EACCES)]
    entries += [Filter(0x06, 0, 0, 0x7fff0000)]
    array = (Filter * len(entries))(*entries)
    program = Program(len(entries), array)
    checked(libc.prctl(22, 2, ctypes.byref(program), 0, 0))
    return abi

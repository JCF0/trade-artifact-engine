"""Synthetic-only dedicated custody regression. Never opens a real credential store."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile

HERE = Path(__file__).resolve().parent


def load(name):
    path = HERE / name
    assert path.is_file(), 'DEDICATED_CUSTODY_SUPPORT_MISSING'
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def run():
    module = load('artifact-custody.py')
    checks = []
    with tempfile.TemporaryDirectory(prefix='artifact-custody-synthetic-') as tmp:
        root = Path(tmp); (root / 'root').mkdir(mode=0o700)
        parent = root / 'root/.artifact-qualification'; parent.mkdir(mode=0o700)
        path = parent / 'helius.env'
        literal = b'HELIUS_API_KEY=SYNTHETIC_ARTIFACT_KEY_0001\n'
        path.write_bytes(literal); path.chmod(0o600)
        original = os.open
        def opened(name, *args, **kwargs):
            # Test-only filesystem root redirection; all descendant traversal is real.
            return original(str(root) if name == '/' else name, *args, **kwargs)
        os.open = opened
        old_environment = os.environ.get('HELIUS_API_KEY')
        os.environ['HELIUS_API_KEY'] = 'DIFFERENT_SYNTHETIC_ENV_0001'
        try:
            key = module.read_authorized_key()
            assert key == bytearray(b'SYNTHETIC_ARTIFACT_KEY_0001')
            checks.append('dedicated-source-not-environment')
            work = root / 'delivery'; work.mkdir()
            fd = module.deliver(work, key)
            try:
                st = os.fstat(fd)
                assert st.st_uid == 65534 and st.st_mode & 0o777 == 0o400 and st.st_nlink == 1
                assert key == bytearray(len(key))
                capability = json.loads(os.read(fd, 73728))
                assert capability == dict(api_key='SYNTHETIC_ARTIFACT_KEY_0001', ca=None, capability_id='helius-mainnet-query-v1')
            finally: os.close(fd)
            checks.append('unchanged-private-delivery-and-wipe')
            def refused(action):
                action()
                try:
                    module.read_authorized_key()
                    raise AssertionError('UNSAFE_SOURCE_ACCEPTED')
                except module.CustodyStop: pass
            refused(lambda: path.chmod(0o644)); checks.append('permissions-refused'); path.chmod(0o600)
            refused(lambda: path.write_bytes(literal * 2)); checks.append('duplicate-refused'); path.write_bytes(literal)
            target = parent / 'target'; path.rename(target); path.symlink_to(target)
            refused(lambda: None); checks.append('symlink-refused'); path.unlink(); target.rename(path)
            hard = parent / 'hard'; os.link(path, hard)
            refused(lambda: None); checks.append('hardlink-refused'); hard.unlink()
            refused(lambda: parent.chmod(0o755)); checks.append('nonprivate-parent-refused'); parent.chmod(0o700)
            path.unlink()
            refused(lambda: None); checks.append('missing-no-fallback')
        finally:
            os.open = original
            if old_environment is None: os.environ.pop('HELIUS_API_KEY', None)
            else: os.environ['HELIUS_API_KEY'] = old_environment
    print(json.dumps(dict(checks=checks, passed=True, synthetic_only=True, external_requests=0)))


if __name__ == '__main__': run()

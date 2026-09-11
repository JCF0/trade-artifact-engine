"""Synthetic whole-launch deadline regression; no real credential/provider access."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('launcher', HERE / 'launch-successor.py')
launcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(launcher)

def preparation(root):
    original = launcher.prepare
    def delayed(*args):
        time.sleep(3)
        raise RuntimeError('SYNTHETIC_PREPARATION_STOP')
    launcher.prepare = delayed
    start = time.monotonic()
    try: result = launcher.run('cleanup-probe', root / 'launch')
    finally: launcher.prepare = original
    elapsed = time.monotonic() - start
    record = dict(classification='SYNTHETIC_ONLY', case='delayed-preparation', elapsed_seconds=elapsed,
        frozen_limit_seconds=2, result=result, passed=elapsed < 2.25 and not result['released'])
    launcher.base.put(root, 'test-result.json', record)
    print(json.dumps(record), flush=True)
    assert record['passed'], 'PREPARATION_ESCAPED_FROZEN_OUTER_DEADLINE'

def delayed_finalization(root, phase):
    original_prepare = launcher.prepare
    original_copy = launcher.shutil.copytree
    original_remove = launcher.shutil.rmtree
    original_put = launcher.base.put
    def stop_prepare(jail, local):
        (jail / 'evidence').mkdir()
        (jail / 'evidence/partial.json').write_text('{"synthetic":true}\n')
        raise RuntimeError('SYNTHETIC_PREPARATION_STOP')
    def delayed_copy(*args, **kwargs):
        if phase == 'evidence': time.sleep(4)
        return original_copy(*args, **kwargs)
    def delayed_remove(*args, **kwargs):
        if phase == 'cleanup': time.sleep(4)
        return original_remove(*args, **kwargs)
    def delayed_put(path, name, value):
        if phase == 'retention' and name == 'outer-result.json': time.sleep(4)
        return original_put(path, name, value)
    launcher.prepare = stop_prepare
    launcher.shutil.copytree = delayed_copy
    launcher.shutil.rmtree = delayed_remove
    launcher.base.put = delayed_put
    start = time.monotonic()
    try: result = launcher.run('cleanup-probe', root / 'launch')
    finally:
        launcher.prepare = original_prepare
        launcher.shutil.copytree = original_copy
        launcher.shutil.rmtree = original_remove
        launcher.base.put = original_put
    elapsed = time.monotonic() - start
    passed = elapsed < 2.25 and not result['cleanup_confirmed'] and result['namespace_retirement_confirmed']
    # Separate test teardown, NOT evidence that timed qualification cleanup succeeded.
    workspace = Path(result['partial_evidence_location'])
    partial_retained = (workspace / 'jail/evidence/partial.json').exists() or (root / 'launch/evidence/partial.json').exists()
    assert partial_retained
    if workspace.exists():
        original_copy(workspace / 'jail/evidence', root / 'test-recovered-partial', dirs_exist_ok=True)
        original_remove(workspace)
    record = dict(case=phase, passed=passed, elapsed_seconds=elapsed, result=result,
        partial_preserved=True, separate_synthetic_test_teardown=True)
    launcher.base.put(root, 'test-result.json', record)
    print(json.dumps(record), flush=True)
    assert passed, 'FINALIZATION_ESCAPED_OUTER_DEADLINE_OR_FALSE_CLEANUP'

def minimal_cleanup_jail(jail, local):
    # The actual Python cleanup-probe entry does not exec Node or need its dependencies.
    # Keep the real privilege/FD/namespace path, but fit preparation inside two seconds.
    jail.chmod(0o755)
    for name in ['proc', 'evidence', 'etc']:
        (jail / name).mkdir(mode=0o755)
    os.chown(jail / 'evidence', 65534, 65534)
    for name in ['hosts', 'worker-hosts']:
        (jail / 'etc' / name).write_text('127.0.0.1 localhost mainnet.helius-rpc.com\n')
        (jail / 'etc' / name).chmod(0o444)
    return []

def escaped(root):
    original = launcher.prepare
    launcher.prepare = minimal_cleanup_jail
    try: result = launcher.run('cleanup-probe', root / 'launch')
    finally: launcher.prepare = original
    proof = root / 'launch/evidence/escaped.json'
    record = dict(case='escaped', result=result, passed=result['cleanup_confirmed']
        and result['namespace_retirement_confirmed'] and result['timeout'] and proof.is_file())
    launcher.base.put(root, 'test-result.json', record)
    print(json.dumps(record), flush=True)
    assert record['passed'], 'ESCAPED_DESCENDANT_NOT_EXERCISED_OR_RETIRED'

def late_preparation(root):
    original = launcher.prepare
    def delayed(jail, local):
        value = minimal_cleanup_jail(jail, local)
        time.sleep(1.2)  # after the work cutoff, before the external management cutoff
        return value
    launcher.prepare = delayed
    try: result = launcher.run('cleanup-probe', root / 'launch')
    finally: launcher.prepare = original
    assert result['timeout'] and not result['released'] and result['cleanup_confirmed']
    assert not (root / 'launch/command.json').exists()
    launcher.base.put(root, 'test-result.json', dict(case='late-preparation', passed=True, result=result))
    print(json.dumps(result), flush=True)

if __name__ == '__main__':
    root = Path(sys.argv[1]); root.mkdir(mode=0o700)
    selection = sys.argv[2] if len(sys.argv) > 2 else 'preparation'
    if selection == 'preparation': preparation(root)
    elif selection == 'escaped': escaped(root)
    elif selection == 'late-preparation': late_preparation(root)
    else:
        assert selection in ('evidence', 'cleanup', 'retention')
        delayed_finalization(root, selection)

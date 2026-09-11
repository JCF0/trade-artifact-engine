"""No-read gate checks for explicit operator entry confirmation and source binding."""
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('launcher', HERE / 'diagnostic-launch.py')
assert spec is not None and spec.loader is not None
launcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(launcher)


def run():
    assert hasattr(launcher, 'require_operator_entry'), 'OPERATOR_ENTRY_CONFIRMATION_GATE_MISSING'
    assert launcher.custody.SOURCE == '/root/.artifact-qualification/helius.env'
    calls = []
    launcher.custody.read_authorized_key = lambda: calls.append('FORBIDDEN')
    valid = dict(source='/root/.artifact-qualification/helius.env', operator_confirmed=True,
                 exit=0, marker='ARTIFACT_CREDENTIAL_ENTRY_PUBLISHED')
    rejected = [{}, {'credential_entry':None}]
    for field, value in [('source','/root/.openclaw/.env'),('operator_confirmed',False),
                         ('operator_confirmed',1),('exit',False),('exit',1),('marker','FILE_EXISTS')]:
        candidate = dict(valid); candidate[field] = value
        rejected.append(dict(credential_entry=candidate))
    candidate = dict(valid, file_parseable=True); rejected.append(dict(credential_entry=candidate))
    for ready in rejected:
        try: launcher.require_operator_entry(ready); raise AssertionError('UNCONFIRMED_ENTRY_ALLOWED')
        except launcher.custody.CustodyStop: pass
    launcher.require_operator_entry(dict(credential_entry=valid))
    assert not calls
    print(json.dumps(dict(passed=True, rejected=len(rejected), valid_confirmation_accepted=True,
                         credential_reads=0, external_requests=0)))


if __name__ == '__main__': run()

"""New-input complete worker tests. All transport is synthetic loopback TLS."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('worker_fixture', HERE / 'worker-local.py')
assert spec is not None and spec.loader is not None
worker: Any = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
N = Path('/root/artifact-private-helius-provider-qualification/qualification-construction-v1')
INPUT = json.loads((N / 'candidate-input.json').read_bytes())
P = json.loads(base64.b64decode(INPUT['provenance_base64']))
worker.SIGNATURES = [t['signature'] for t in P['original_setup']['transactions']]


def run(root, selection):
    root.mkdir(mode=0o700)
    cases = ['complete', 'member-mismatch', 'record-contradiction', 'unsupported-version', 'input-extra', 'setup-contradiction', 'simulation-refusal', 'blocked-input'] if selection == 'all' else [selection]
    before = {p.name: worker.launcher.base.sha(p) for p in HERE.iterdir() if p.is_file()}
    worker.launcher.base.put(root, 'dispatch.json', dict(cases=cases, source_before=before, external_requests=0))
    results = []
    with tempfile.TemporaryDirectory(prefix='artifact-qualification-tls-') as d:
        cert, key = Path(d) / 'cert.pem', Path(d) / 'fixture-key.pem'
        subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', str(key), '-out', str(cert), '-subj', '/CN=mainnet.helius-rpc.com', '-addext', 'subjectAltName=DNS:mainnet.helius-rpc.com'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for case in cases:
            value = copy.deepcopy(INPUT)
            if case == 'member-mismatch': value['members'][0]['base64'] = base64.b64encode(b'altered').decode()
            if case == 'record-contradiction':
                m = next(x for x in value['members'] if x['path'] == 'ata-creation-finalized.json')
                r = json.loads(base64.b64decode(m['base64'])); r['block_time'] += 1
                m['base64'] = base64.b64encode(json.dumps(r).encode()).decode()
            if case == 'unsupported-version':
                p = copy.deepcopy(P); p['schema'] += '_UNSUPPORTED'
                value['provenance_base64'] = base64.b64encode(json.dumps(p).encode()).decode()
            if case == 'input-extra': value['unexpected'] = True
            original = worker.launcher.prepare
            def prepare(jail, local):
                identities = original(jail, local)
                path = jail / 'qualification-input-v1.json'
                if case == 'blocked-input': os.mkfifo(path, 0o444); path.chmod(0o444)
                else: path.write_text(json.dumps(value)); path.chmod(0o444)
                return identities
            worker.launcher.prepare = prepare
            parent = root / case; parent.mkdir()
            scenario = case if case in ['complete', 'setup-contradiction', 'simulation-refusal'] else 'input-extra'
            try:
                if case == 'blocked-input': passed = worker.run_case(parent, scenario, cert, key, expect_timeout=True)
                else: passed = worker.run_case(parent, scenario, cert, key)
            finally: worker.launcher.prepare = original
            if passed and case in ['complete', 'simulation-refusal', 'setup-contradiction']:
                e = parent / scenario / 'evidence'
                admission = json.loads((e / 'qualification-admission.json').read_bytes())
                assert admission['qualification_provenance_sha256'] == INPUT['qualification_provenance_sha256']
                if case != 'setup-contradiction':
                    construction = json.loads((e / 'construction.json').read_bytes())
                    assert construction['plan']['version'] == 'ARTIFACT_QUALIFICATION_UNSIGNED_PLAN_V1'
                    assert 'mandate' not in construction['input'] and 'mandate_digest' not in construction['plan']
            results.append(dict(case=case, passed=passed))
    assert before == {p.name: worker.launcher.base.sha(p) for p in HERE.iterdir() if p.is_file()}
    worker.launcher.base.put(root, 'summary.json', dict(results=results, source_after=before, tls_removed=not Path(d).exists(), external_requests=0, real_credential_reads=0))
    return 0 if all(x['passed'] for x in results) else 1

if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(run(Path(sys.argv[1]), sys.argv[2]))

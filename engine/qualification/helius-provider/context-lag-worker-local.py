"""Context-lag successor integration: actual confined worker, synthetic TLS/custody.
Only public fixture input and (for deadline coverage) a tighter session limit are injected.
"""
import base64
import copy
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('launcher', HERE / 'full-launch.py')
assert spec is not None and spec.loader is not None
launcher: Any = importlib.util.module_from_spec(spec); spec.loader.exec_module(launcher)
ROOT = launcher.base.ROOT
C = Path('/root/artifact-private-helius-provider-qualification-continuation')
M = json.loads((C / 'local-2/confined/evidence/build-positive/construction.json').read_bytes())['input']['mandate']
ROUTE = json.loads((ROOT / 'engine/orca-readiness-sdk/fixtures/raw-rpc-3107-getMultipleAccounts.json').read_bytes())['result']['value']
SLOT = 900000000
SIGNATURES = ['2' * 88, '3' * 88]
MAXIMA = dict(getGenesisHash=1, getSlot=1, getBlock=1, getMultipleAccounts=2,
    getTokenAccountsByOwner=2, getSignaturesForAddress=15, getTransaction=2,
    getAccountInfo=1, getLatestBlockhash=1, getFeeForMessage=1, getBlockHeight=1, simulateTransaction=1)

def sha(b): return hashlib.sha256(b).hexdigest()
def at(value): return dict(context=dict(slot=SLOT), value=value)
def account(owner, raw=b''):
    return dict(owner=owner, lamports=1, executable=False, data=[base64.b64encode(raw).decode(), 'base64'])

def run_case(root, case, cert, key, expect_timeout=False):
    destination = root / case
    received, failures = [], []
    anchor_time = int(time.time())
    wallet = M['wallet_scope']; route = M['route_scope']
    addresses = [wallet['wallet'], wallet['jup_ata'], wallet['usdc_ata']]
    opening = [account('11111111111111111111111111111111'), account(wallet['token_program']), account(wallet['token_program'])]
    counts = {}
    attempts = {}
    expected = {'lag-success': 24, 'shared-success': 25, 'persistent': 7,
        'shared-exhausted': 23, 'budget': 29, 'deadline': 1,
        'other-error': 5, 'authentication': 5, 'transport': 5,
        'simulation-error': 23, 'watermark': 7, 'lowered-slot': 6}
    success = case in ('lag-success', 'shared-success')
    def response(body):
        method, params = body['method'], body['params']
        counts[method] = counts.get(method, 0) + 1
        assert method in MAXIMA and counts[method] <= MAXIMA[method] and sum(counts.values()) <= 29
        if method == 'getGenesisHash': assert params == []; return M['network']['genesis_hash']
        if method == 'getSlot': assert params == [dict(commitment='finalized')]; return SLOT
        if method == 'getBlock':
            assert params == [SLOT, dict(commitment='finalized', transactionDetails='none', rewards=False, maxSupportedTransactionVersion=0)]
            return dict(blockTime=anchor_time)
        if method == 'getMultipleAccounts':
            assert params[1] == dict(commitment='finalized', encoding='base64', minContextSlot=SLOT)
            if counts[method] == 1: assert params[0] == addresses; return at(opening)
            assert len(params[0]) == 9 and params[0][0] == route['pool']
            return at(copy.deepcopy(ROUTE) + [None, account(wallet['token_program'], bytes(82)), account(wallet['token_program'], bytes(82))])
        if method == 'getTokenAccountsByOwner':
            assert params[0] == wallet['wallet'] and params[2] == dict(commitment='finalized', encoding='base64', minContextSlot=SLOT)
            result = at([dict(pubkey=addresses[i], account=opening[i]) for i in (1, 2)] if params[1]['programId'] == wallet['token_program'] else [])
            if case == 'watermark' and params[1]['programId'] != wallet['token_program']: result['context']['slot'] += 1
            if case == 'lowered-slot': result['context']['slot'] -= 1
            return result
        if method == 'getSignaturesForAddress':
            assert params[0] in addresses
            cfg = dict(commitment='finalized', limit=100, minContextSlot=SLOT)
            if 'before' in params[1]:
                if case == 'budget':
                    chain = [SIGNATURES[0], '4' * 88, '5' * 88]
                    assert params[1]['before'] in chain
                    i = chain.index(params[1]['before']) + 1
                    return [] if i == 3 else [dict(signature=chain[i], slot=SLOT - 1, blockTime=M['setup_authority']['latest_setup_block_time'], err=None)]
                assert params[1] == dict(cfg, before=SIGNATURES[0]); return []
            assert params[1] == cfg
            return [dict(signature=SIGNATURES[0], slot=SLOT - 1, blockTime=M['setup_authority']['latest_setup_block_time'], err=None)]
        if method == 'getTransaction':
            assert params[0] in SIGNATURES and params[1] == dict(commitment='finalized', encoding='json', maxSupportedTransactionVersion=0)
            return dict(slot=SLOT - 1, blockTime=M['setup_authority']['latest_setup_block_time'], meta=dict(err=None),
                transaction=dict(signatures=[SIGNATURES[1] if case == 'setup-contradiction' else params[0]], message=dict(accountKeys=addresses)))
        if method == 'getAccountInfo':
            assert params == [route['pool'], dict(commitment='finalized', encoding='base64', minContextSlot=SLOT)]
            return at(copy.deepcopy(ROUTE[0]))
        if method == 'getLatestBlockhash':
            assert params == [dict(commitment='finalized', minContextSlot=SLOT)]
            return at(dict(blockhash=wallet['wallet'], lastValidBlockHeight=SLOT + 100))
        if method == 'getFeeForMessage':
            assert params[1] == dict(commitment='finalized', minContextSlot=SLOT)
            return at(5000)
        if method == 'getBlockHeight':
            assert params == [dict(commitment='finalized', minContextSlot=SLOT)]; return SLOT
        if method == 'simulateTransaction':
            wire = base64.b64decode(params[0], validate=True)
            assert wire[0] == 1 and wire[1:65] == bytes(64)
            assert params[1] == dict(encoding='base64', commitment='finalized', sigVerify=False, replaceRecentBlockhash=False, minContextSlot=SLOT)
            return at(dict(err=dict(InstructionError=[0, 'InvalidArgument']) if case == 'simulation-refusal' else None,
                unitsConsumed=1000, logs=['synthetic execution only'], replacementBlockhash=None))
        raise AssertionError('UNEXPECTED_METHOD')
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            try:
                size = int(self.headers['Content-Length']); assert 0 < size <= 1048576
                request = self.rfile.read(size); body = json.loads(request)
                assert self.path == '/?api-key=SYNTHETIC_QUALIFICATION_KEY_0001' and self.headers.get('Authorization') is None
                identity = json.dumps([body['method'], body['params']], sort_keys=True)
                attempts[identity] = attempts.get(identity, 0) + 1
                ordinal = attempts[identity]
                classic = body['method'] == 'getTokenAccountsByOwner' and body['params'][1]['programId'] == wallet['token_program']
                lag = (classic and ((case in ('lag-success', 'shared-success', 'watermark', 'lowered-slot') and ordinal == 1)
                    or case == 'persistent' or (case in ('shared-exhausted', 'budget') and ordinal <= 2)))
                lag = lag or (body['method'] == 'getFeeForMessage' and case in ('shared-success', 'shared-exhausted') and ordinal == 1)
                lag = lag or (case == 'simulation-error' and body['method'] == 'simulateTransaction') or case == 'deadline'
                noneligible = classic and case in ('other-error', 'authentication', 'transport')
                if case == 'deadline': time.sleep(0.8)
                if lag or noneligible:
                    envelope = dict(jsonrpc='2.0', id=body['id'], error=dict(code=-32005 if case == 'other-error' else -32016,
                        message='Minimum context slot has not been reached', data=dict(contextSlot=SLOT-1)))
                else: envelope = dict(jsonrpc='2.0', id=body['id'], result=response(body))
                # Noncanonical whitespace is intentional; retained bytes must be exact.
                raw = ('  ' + json.dumps(envelope, separators=(', ', ': ')) + '\n').encode()
                received.append(dict(method=body['method'], request=request, response=raw, at=time.monotonic()))
                if case == 'transport' and classic: self.close_connection = True; return
                self.send_response(401 if case == 'authentication' and classic else 200)
                self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
            except Exception:
                failures.append('SYNTHETIC_SERVER_ASSERTION_FAILED')
                self.close_connection = True
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try: result = launcher.run('worker-local', destination, server.server_port, cert.read_text(), 'complete')
    finally: server.shutdown(); server.server_close(); thread.join(timeout=2)
    evidence = destination / 'evidence'
    # Retain actual clean fixture exchanges before assertions, including failed attempts.
    wire_root = destination / 'synthetic-server'; wire_root.mkdir(mode=0o700)
    for i, row in enumerate(received, 1):
        for kind in ('request', 'response'):
            with (wire_root / f'{i:02}-{kind}.json').open('xb') as f: f.write(row[kind])
    summary = dict(classification='SYNTHETIC_ONLY_NOT_PROVIDER', case=case, launcher=result,
        server_methods=[r['method'] for r in received], server_failures=failures, passed=False,
        external_requests=0, real_credential_reads=0)
    try:
        assert not failures and result['released'] and result['isolation_verified']
        assert not result['residual_pids'] and result['temporary_root_removed']
        if expect_timeout:
            assert result['timeout'] and result['cleanup_confirmed'] and result['namespace_retirement_confirmed']
            assert not received and result['elapsed_seconds'] < 60.5
        else:
            assert result['exit'] == (0 if success else 1) and not result['timeout']
        if expect_timeout:
            pass
        elif case == 'input-extra':
            assert not received and json.loads((evidence / 'worker-stop.json').read_bytes())['consumed'] == 0
        else:
            ledger = json.loads((evidence / 'ledger.json').read_bytes())
            assert ledger['consumed'] == len(received) == expected[case]
            actual_counts = {k: sum(r['method'] == k for r in received) for k in set(r['method'] for r in received)}
            assert ledger['counts'] == actual_counts
            assert ledger['admitted_bytes'] == sum(len(r['response']) for i, r in enumerate(received) if not (case in ('transport', 'authentication') and i == 4))
            assert ledger['version'] == 'ARTIFACT_QUALIFICATION_CONTEXT_LAG_SESSION_V1'
            assert ledger['retries_reserved'] == {'lag-success': 1, 'shared-success': 2, 'persistent': 2, 'shared-exhausted': 2, 'budget': 2, 'watermark': 1, 'lowered-slot': 1}.get(case, 0)
            expected_stop = {'persistent': 'QUALIFICATION_CONTEXT_LAG_ALLOWANCE', 'shared-exhausted': 'QUALIFICATION_CONTEXT_LAG_ALLOWANCE', 'budget': 'QUALIFICATION_CALL_BUDGET', 'deadline': 'QUALIFICATION_DEADLINE'}
            if case in expected_stop: assert ledger['stop_reason'] == expected_stop[case]
            assert ledger['closed'] is True
            for i, row in enumerate(received, 1):
                stem = f'call-{i:02}'
                reserved = json.loads((evidence / (stem + '-reserved.json')).read_bytes())
                completion = json.loads((evidence / (stem + '-completion.json')).read_bytes())
                assert reserved['disposition'] == 'RESERVED_POSSIBLY_DISPATCHED'
                for kind in ('request', 'response'):
                    if kind == 'response' and case in ('transport', 'authentication') and i == 5:
                        assert not (evidence / (stem + '-response.json')).exists(); continue
                    assert (evidence / (stem + '-' + kind + '.json')).read_bytes() == row[kind]
                    assert completion[kind + '_identity'] == dict(bytes=len(row[kind]), sha256=sha(row[kind]))
                if completion['attempt_ordinal'] > 1:
                    previous = ledger['ledger'][i-2]
                    previous_body = json.loads(received[i-2]['request']); current_body = json.loads(row['request'])
                    assert previous['rpc_code'] == -32016 and previous['logical_ordinal'] == completion['logical_ordinal']
                    assert previous_body['method'] == current_body['method'] and previous_body['params'] == current_body['params']
                    assert previous_body['id'] != current_body['id']
                    assert received[i-1]['at'] - received[i-2]['at'] >= (0.25 if completion['retry_ordinal'] == 1 else 0.5)
            findings = json.loads((evidence / 'findings.json').read_bytes())
            if success:
                assert findings['simulation'] == 'OBSERVED_UNSIGNED_EXECUTION_SUCCESS'
                assert findings['disposition'] == 'PARTIAL_QUALIFICATION_ONLY'
                assert 'TWO_RETAINED_SETUP_BODY_SAMPLES' in findings['passed']
                construction = json.loads((evidence / 'construction.json').read_bytes())
                assert construction['input']['minimum_output_raw'] == '21347418'
                message = base64.b64decode(construction['plan']['message_base64'], validate=True)
                wire = (evidence / 'unsigned-wire.bin').read_bytes()
                assert wire == b'\x01' + bytes(64) + message
                assert sha(message) == construction['plan']['message_sha256']
            else:
                assert findings['disposition'] == 'STOPPED_PARTIAL_EVIDENCE'
                assert actual_counts.get('simulateTransaction', 0) == (1 if case == 'simulation-error' else 0)
            summary.update(consumed=ledger['consumed'], retries_reserved=ledger['retries_reserved'], counts=actual_counts, stop_reason=ledger['stop_reason'])
        for p in evidence.rglob('*'):
            if p.is_file():
                data = p.read_bytes()
                assert b'SYNTHETIC_QUALIFICATION_KEY_0001' not in data and b'api-key=' not in data and b'BEGIN PRIVATE KEY' not in data
        summary['passed'] = True
    except Exception:
        summary['failure'] = 'WORKER_INTEGRATION_ASSERTION_FAILED'
    launcher.base.put(destination, 'integration-result.json', summary)
    print(json.dumps(summary), flush=True)
    return summary['passed']

def run(destination, selection):
    root = Path(destination); root.mkdir(mode=0o700)
    spec = importlib.util.spec_from_file_location('entry', HERE / 'credential-entry.py')
    assert spec is not None and spec.loader is not None
    entry = importlib.util.module_from_spec(spec); spec.loader.exec_module(entry)
    value = json.loads((Path('/root/artifact-private-helius-provider-qualification/qualification-construction-v1') / 'candidate-input.json').read_bytes())
    provenance = json.loads(base64.b64decode(value['provenance_base64']))
    global SIGNATURES
    SIGNATURES = [t['signature'] for t in provenance['original_setup']['transactions']]
    original_prepare = launcher.prepare
    def prepare(jail, local):
        identities = original_prepare(jail, local)
        p = jail / 'qualification-input-v1.json'; p.write_text(json.dumps(value)); p.chmod(0o444)
        if (HERE / 'worker-context-lag-v1.mjs').exists():
            options = '{ limits: { ...LIMITS, overall_ms: 1000 } }' if selection == 'deadline' else '{}'
            p = jail / 'harness/context-lag-fixture-entry.mjs'
            p.write_text("import { run } from './worker-context-lag-v1.mjs'; import { LIMITS } from './bounded-context-lag-v1.mjs'; await run(" + options + ");\n"); p.chmod(0o444)
        return identities
    launcher.prepare = prepare
    with tempfile.TemporaryDirectory(prefix='artifact-context-lag-synthetic-') as directory:
        private = Path(directory); (private / 'root').mkdir(mode=0o700)
        credentials = private / 'root/.artifact-qualification'; credentials.mkdir(mode=0o700)
        fd = os.open(credentials, os.O_RDONLY | os.O_DIRECTORY)
        try: entry._store(fd, bytearray(b'SYNTHETIC_QUALIFICATION_KEY_0001'))
        finally: os.close(fd)
        cert, key = private / 'cert.pem', private / 'fixture-key.pem'
        subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', str(key), '-out', str(cert), '-subj', '/CN=mainnet.helius-rpc.com', '-addext', 'subjectAltName=DNS:mainnet.helius-rpc.com'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        original_open = os.open
        def synthetic_open(name, *args, **kwargs):
            if name == launcher.custody.NAME:
                proof = original_open(private / 'dedicated-read-observed', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(proof)
            return original_open(str(private) if name == '/' else name, *args, **kwargs)
        os.open = synthetic_open
        try: passed = run_case(root, selection, cert, key)
        finally: os.open = original_open; launcher.prepare = original_prepare
        assert (private / 'dedicated-read-observed').is_file()
    launcher.base.put(root, 'custody-coverage.json', dict(synthetic_root_removed=not private.exists(), dedicated_reader_observed=True, external_requests=0, real_credential_reads=0))
    return 0 if passed else 1

if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(run(*sys.argv[1:]))

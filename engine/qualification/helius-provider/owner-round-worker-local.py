"""Synthetic complete-worker tests; only the fixed local provider/custody path is used."""
import base64
import copy
import http.server
import importlib.util
import json
from pathlib import Path
import ssl
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prior_fixture', HERE / 'context-lag-worker-local.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
CASES = {'recover': (26, 0, True), 'unchanged': (23, 0, True),
    'persistent': (9, 0, False), 'first-data-conflict': (6, 0, False),
    'metadata-conflict': (6, 0, False), 'epoch-conflict': (6, 0, False), 'changed-direct': (7, 0, False),
    'second-data-conflict': (9, 0, False), 'mix': (9, 0, False),
    'below-floor': (5, 0, False), 'invalid': (6, 0, False),
    'lag-recover': (28, 2, True), 'lag-exhausted': (10, 2, False),
    'budget': (29, 0, False), 'restart-budget': (6, 0, False),
    'deadline': (1, 0, False), 'simulation-error': (26, 0, False)}

def run_case(root, case, cert, key):
    assert case in CASES
    destination = root / case
    received, failures = [], []
    counts = {}; direct_round = 0
    slot = m.SLOT; anchor_time = int(time.time())
    wallet, route = m.M['wallet_scope'], m.M['route_scope']
    addresses = [wallet['wallet'], wallet['jup_ata'], wallet['usdc_ata']]
    opening = [m.account('11111111111111111111111111111111'), m.account(wallet['token_program']), m.account(wallet['token_program'])]
    for value in opening: value['rentEpoch'] = 18446744073709551615
    def at(value, n): return dict(context=dict(slot=n), value=value)
    def cfg(n): return dict(commitment='finalized', encoding='base64', minContextSlot=n)
    def response(body):
        nonlocal direct_round
        method, params = body['method'], body['params']
        if method == 'getGenesisHash': assert params == []; return m.M['network']['genesis_hash']
        if method == 'getSlot': assert params == [dict(commitment='finalized')]; return slot
        if method == 'getBlock':
            assert params == [slot, dict(commitment='finalized', transactionDetails='none', rewards=False, maxSupportedTransactionVersion=0)]
            return dict(blockTime=anchor_time)
        if method == 'getMultipleAccounts' and params[0] == addresses:
            direct_round += 1
            assert direct_round <= 2 and params[1] == cfg(slot + direct_round - 1)
            value = copy.deepcopy(opening)
            if case == 'changed-direct' and direct_round == 2: value[0]['lamports'] += 1
            return at(value, slot + direct_round - 1)
        accepted = slot + (0 if case == 'unchanged' else 1)
        if method == 'getTokenAccountsByOwner':
            assert params[0] == wallet['wallet'] and params[2] == cfg(slot + direct_round - 1)
            classic = params[1]['programId'] == wallet['token_program']
            value = [dict(pubkey=addresses[i], account=copy.deepcopy(opening[i])) for i in (1, 2)] if classic else []
            n = slot + direct_round - 1
            if direct_round == 1 and case != 'unchanged' and classic: n += 1
            if direct_round == 2 and case in ('persistent', 'mix') and classic: n += 1
            if case == 'below-floor' and classic: n = slot - 1
            if classic and (case == 'first-data-conflict' or (case == 'second-data-conflict' and direct_round == 2)):
                value[0]['account']['data'][0] = base64.b64encode(b'contradiction').decode()
            if classic and case == 'metadata-conflict': value[0]['account']['lamports'] += 1
            if classic and case == 'epoch-conflict': value[0]['account']['rentEpoch'] -= 1
            if not classic and case == 'invalid': value = None
            return at(value, n)
        if method == 'getSignaturesForAddress':
            assert params[0] in addresses
            options = dict(commitment='finalized', limit=100, minContextSlot=accepted)
            chain = [m.SIGNATURES[0], '4' * 88, '5' * 88] if case == 'budget' else [m.SIGNATURES[0]]
            if 'before' in params[1]:
                assert params[1] == dict(options, before=params[1]['before'])
                i = chain.index(params[1]['before']) + 1
            else: assert params[1] == options; i = 0
            return [] if i == len(chain) else [dict(signature=chain[i], slot=slot - 1,
                blockTime=m.M['setup_authority']['latest_setup_block_time'], err=None)]
        if method == 'getTransaction':
            assert params[0] in m.SIGNATURES and params[1] == dict(commitment='finalized', encoding='json', maxSupportedTransactionVersion=0)
            return dict(slot=slot - 1, blockTime=m.M['setup_authority']['latest_setup_block_time'], meta=dict(err=None),
                transaction=dict(signatures=[params[0]], message=dict(accountKeys=addresses)))
        if method == 'getAccountInfo':
            assert params == [route['pool'], cfg(accepted)]; return at(copy.deepcopy(m.ROUTE[0]), accepted)
        if method == 'getMultipleAccounts':
            assert len(params[0]) == 9 and params[0][0] == route['pool'] and params[1] == cfg(accepted)
            return at(copy.deepcopy(m.ROUTE) + [None, m.account(wallet['token_program'], bytes(82)), m.account(wallet['token_program'], bytes(82))], accepted)
        if method == 'getLatestBlockhash':
            assert params == [dict(commitment='finalized', minContextSlot=accepted)]
            return at(dict(blockhash=wallet['wallet'], lastValidBlockHeight=slot + 100), accepted)
        if method == 'getFeeForMessage':
            assert params[1] == dict(commitment='finalized', minContextSlot=accepted); return at(5000, accepted)
        if method == 'getBlockHeight':
            assert params == [dict(commitment='finalized', minContextSlot=accepted)]; return slot
        if method == 'simulateTransaction':
            wire = base64.b64decode(params[0], validate=True)
            assert wire[0] == 1 and wire[1:65] == bytes(64)
            assert params[1] == dict(encoding='base64', commitment='finalized', sigVerify=False, replaceRecentBlockhash=False, minContextSlot=accepted)
            return at(dict(err=None, unitsConsumed=1000, logs=['synthetic only'], replacementBlockhash=None), accepted)
        raise AssertionError('UNEXPECTED_METHOD')
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            try:
                request = self.rfile.read(int(self.headers['Content-Length'])); body = json.loads(request)
                assert self.path == '/?api-key=SYNTHETIC_QUALIFICATION_KEY_0001' and self.headers.get('Authorization') is None
                method = body['method']; counts[method] = counts.get(method, 0) + 1
                assert sum(counts.values()) <= 29
                classic = method == 'getTokenAccountsByOwner' and body['params'][1]['programId'] == wallet['token_program']
                lag = (case == 'lag-recover' and ((classic and counts[method] == 1) or (method == 'getFeeForMessage' and counts[method] == 1)))
                lag |= case == 'lag-exhausted' and classic and (counts[method] <= 2 or direct_round == 2)
                lag |= case == 'simulation-error' and method == 'simulateTransaction'
                lag |= case == 'deadline'
                if case == 'deadline': time.sleep(0.8)
                envelope = dict(jsonrpc='2.0', id=body['id'])
                if lag: envelope['error'] = dict(code=-32016, message='Minimum context slot has not been reached')
                else: envelope['result'] = response(body)
                raw = ('  ' + json.dumps(envelope) + '\n').encode()
                received.append(dict(request=request, response=raw, at=time.monotonic(), method=method))
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
            except Exception:
                failures.append('SYNTHETIC_SERVER_ASSERTION_FAILED'); self.close_connection = True
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(cert, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    original_prepare = m.launcher.prepare
    def prepare(jail, local):
        identities = original_prepare(jail, local)
        if case in ('deadline', 'restart-budget'):
            # Test-only tighter limits through the actual exported complete worker.
            p = jail / 'harness/worker-owner-round-v1.mjs'
            actual = jail / 'harness/tight-limit-worker.mjs'
            actual.write_bytes(p.read_bytes()); actual.chmod(0o444)
            options = 'overall_ms: 1000' if case == 'deadline' else 'calls: 25'
            p.write_text("import { run } from './tight-limit-worker.mjs'; import { LIMITS } from './bounded-owner-round-v1.mjs'; await run({ limits: { ...LIMITS, " + options + " } });\n"); p.chmod(0o444)
        return identities
    m.launcher.prepare = prepare
    try: result = m.launcher.run('worker-local', destination, server.server_port, cert.read_text(), 'complete')
    finally:
        m.launcher.prepare = original_prepare
        server.shutdown(); server.server_close(); thread.join(timeout=2)
    evidence = destination / 'evidence'; wire_root = destination / 'synthetic-server'; wire_root.mkdir(mode=0o700)
    for i, row in enumerate(received, 1):
        for kind in ('request', 'response'): (wire_root / f'{i:02}-{kind}.json').write_bytes(row[kind])
    summary = dict(case=case, classification='SYNTHETIC_ONLY_NOT_PROVIDER', launcher=result, passed=False,
        external_requests=0, real_credential_reads=0, server_failures=failures)
    try:
        total, retries, success = CASES[case]
        assert not failures and result['released'] and result['isolation_verified']
        assert result['exit'] == (0 if success else 1) and not result['timeout']
        assert all(result[k] for k in ['cleanup_confirmed', 'temporary_root_removed', 'namespace_retirement_confirmed', 'supervisor_domains_retired'])
        assert not result['residual_pids'] and result['elapsed_seconds'] < 60
        ledger = json.loads((evidence / 'ledger.json').read_bytes())
        assert ledger['consumed'] == len(received) == total and ledger['retries_reserved'] == retries
        assert ledger['counts'] == counts and ledger['closed']
        assert ledger['admitted_bytes'] == sum(len(row['response']) for row in received)
        for i, row in enumerate(received, 1):
            completion = json.loads((evidence / f'call-{i:02}-completion.json').read_bytes())
            reserved = json.loads((evidence / f'call-{i:02}-reserved.json').read_bytes())
            assert reserved['disposition'] == 'RESERVED_POSSIBLY_DISPATCHED'
            for kind in ('request', 'response'):
                assert (evidence / f'call-{i:02}-{kind}.json').read_bytes() == row[kind]
                assert completion[kind + '_identity'] == dict(bytes=len(row[kind]), sha256=m.sha(row[kind]))
            if completion['attempt_ordinal'] > 1:
                prior = json.loads(received[i-2]['request']); current = json.loads(row['request'])
                assert prior['method'] == current['method'] and prior['params'] == current['params'] and prior['id'] != current['id']
                assert ledger['ledger'][i-2]['rpc_code'] == -32016
                assert row['at'] - received[i-2]['at'] >= (0.25 if completion['retry_ordinal'] == 1 else 0.5)
        findings = json.loads((evidence / 'findings.json').read_bytes())
        if success:
            assert findings['simulation'] == 'OBSERVED_UNSIGNED_EXECUTION_SUCCESS'
            assert findings['disposition'] == 'PARTIAL_QUALIFICATION_ONLY'
            build = json.loads((evidence / 'construction.json').read_bytes())
            message = base64.b64decode(build['plan']['message_base64'], validate=True)
            assert (evidence / 'unsigned-wire.bin').read_bytes() == b'\x01' + bytes(64) + message
            assert m.sha(message) == build['plan']['message_sha256']
            assert build['input']['minimum_output_raw'] == '21347418'
        else: assert findings['disposition'] == 'STOPPED_PARTIAL_EVIDENCE'
        assert counts.get('simulateTransaction', 0) == (1 if success or case == 'simulation-error' else 0)
        if case in ('recover', 'lag-recover', 'unchanged', 'budget', 'simulation-error'):
            admission = json.loads((evidence / 'owner-round-admission.json').read_bytes())
            assert admission['round'] == (1 if case == 'unchanged' else 2)
            round_record = evidence / f"owner-round-{admission['round']}-completion.json"
            assert admission['record_identity']['sha256'] == m.sha(round_record.read_bytes())
            record = json.loads(round_record.read_bytes())
            assert len(set(record['context_slots'])) == 1 and len(record['observations']) == 3
            assert all(row['first_ordinal'] >= record['first_ordinal'] for row in record['observations'])
        else: assert not (evidence / 'owner-round-admission.json').exists()
        expected_stop = {'budget': 'QUALIFICATION_CALL_BUDGET', 'restart-budget': 'QUALIFICATION_DOWNSTREAM_CALL_BUDGET',
            'deadline': 'QUALIFICATION_DEADLINE', 'lag-exhausted': 'QUALIFICATION_CONTEXT_LAG_ALLOWANCE'}
        if case in expected_stop: assert ledger['stop_reason'] == expected_stop[case]
        for p in evidence.rglob('*'):
            if p.is_file():
                raw = p.read_bytes(); assert b'SYNTHETIC_QUALIFICATION_KEY_0001' not in raw and b'api-key=' not in raw
        summary.update(passed=True, consumed=total, retries_reserved=retries, counts=counts, stop_reason=ledger['stop_reason'])
    except Exception as error:
        import traceback
        summary.update(failure='WORKER_INTEGRATION_ASSERTION_FAILED', detail=traceback.format_exc())
    m.launcher.base.put(destination, 'integration-result.json', summary)
    print(json.dumps(summary), flush=True)
    return summary['passed']

m.run_case = run_case
if __name__ == '__main__': sys.exit(m.run(*sys.argv[1:]))

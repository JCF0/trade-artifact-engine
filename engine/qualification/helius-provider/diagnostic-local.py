"""Synthetic diagnostics through the dedicated reader, with a test filesystem root."""
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

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('diagnostic_launcher', HERE / 'diagnostic-launch.py')
launcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(launcher)

def run(destination, case):
    assert case in ('clean', 'untrusted', 'status401', 'echo', 'stall', 'oversize', 'disconnect')
    destination = Path(destination); destination.mkdir(mode=0o700)

    with tempfile.TemporaryDirectory(prefix='artifact-diagnostic-local-') as directory:
        root = Path(directory)
        (root / 'root').mkdir(mode=0o700)
        credentials = root / 'root/.artifact-qualification'; credentials.mkdir(mode=0o700)
        spec = importlib.util.spec_from_file_location('synthetic_entry', HERE / 'credential-entry.py')
        assert spec is not None and spec.loader is not None
        entry = importlib.util.module_from_spec(spec); spec.loader.exec_module(entry)
        directory_fd = os.open(credentials, os.O_RDONLY | os.O_DIRECTORY)
        try: entry._store(directory_fd, bytearray(b'SYNTHETIC_QUALIFICATION_KEY_0001'))
        finally: os.close(directory_fd)
        cert, key = root / 'certificate.pem', root / 'tls-fixture-key.pem'
        subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', str(key), '-out', str(cert), '-subj', '/CN=mainnet.helius-rpc.com',
            '-addext', 'subjectAltName=DNS:mainnet.helius-rpc.com'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        received = []; sni = []; raw_clean = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                try:
                    n = int(self.headers['Content-Length']); assert 0 < n <= 1048576
                    body = self.rfile.read(n)
                    request = json.loads(body); assert request['method'] == 'getGenesisHash' and request['params'] == []
                    assert self.path == '/?api-key=SYNTHETIC_QUALIFICATION_KEY_0001'
                    assert self.headers.get('Authorization') is None
                    received.append(body)
                    if case == 'stall': time.sleep(6); return
                    if case == 'disconnect': self.connection.close(); return
                    raw = ('{ "jsonrpc":"2.0", "id":"' + request['id'] + '", "result":"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }\n').encode()
                    if case == 'echo': raw = b'{"result":"SYNTHETIC_QUALIFICATION_KEY_0001"}'
                    raw_clean.append(raw)
                    self.send_response(401 if case == 'status401' else 200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(1048577 if case == 'oversize' else len(raw)))
                    self.end_headers(); self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError): pass
        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True
            def handle_error(self, *args): pass
        server = Server(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
        context.set_servername_callback(lambda sock, name, ctx: sni.append(name == 'mainnet.helius-rpc.com'))
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        original_open = os.open
        def synthetic_open(name, *args, **kwargs):
            # Test-only root redirection. The actual fixed directory traversal,
            # named parser, delivery helper and FD5 path remain unmodified.
            if name == launcher.custody.NAME:
                proof_fd = original_open(root / 'dedicated-read-observed', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(proof_fd)
            return original_open(str(root) if name == '/' else name, *args, **kwargs)
        os.open = synthetic_open
        try:
            result = launcher.run('local', destination / 'confined', server.server_port, None if case == 'untrusted' else cert.read_text())
        finally:
            os.open = original_open
            server.shutdown(); server.server_close(); thread.join(timeout=2)
        evidence = destination / 'confined/evidence'
        observations = [json.loads(p.read_bytes()) for p in sorted(evidence.glob('diagnostic-*-??.json'))]
        ledger_path = evidence / 'diagnostic-ledger.json'
        ledger = json.loads(ledger_path.read_bytes()) if ledger_path.exists() else None
        stages = [r['stage'] for r in observations]
        expected = {'clean':'ADMITTED', 'untrusted':'REQUEST_ERROR', 'status401':'HEADERS_REJECTED',
            'echo':'SCREENING_REJECTED', 'stall':'DEADLINE', 'oversize':'HEADERS_REJECTED', 'disconnect':'REQUEST_ERROR'}[case]
        checks = dict(expected_stage=expected in stages, one_or_zero_requests=len(received) == (0 if case == 'untrusted' else 1),
            fixed_sni=bool(sni) and all(sni), consumed_once=ledger is not None and ledger['consumed'] == 1,
            expected_exit=result.get('exit') == (0 if case == 'clean' else 1), cleanup=result.get('cleanup_confirmed') is True,
            exact_clean_body=case != 'clean' or (evidence / 'call-01-response.json').read_bytes() == raw_clean[0],
            no_rejected_body=case == 'clean' or not (evidence / 'call-01-response.json').exists())
        for p in evidence.rglob('*'):
            if p.is_file():
                b = p.read_bytes()
                assert b'SYNTHETIC_QUALIFICATION_KEY_0001' not in b and b'api-key=' not in b
        checks['no_synthetic_secret_leak'] = True
        checks['dedicated_reader_used'] = (root / 'dedicated-read-observed').is_file()
        summary = dict(case=case, checks=checks, observations=observations, launcher=result,
            fixture_requests=len(received), real_provider_requests=0, credential_reads=0,
            source_hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in HERE.glob('diagnostic-*') if p.is_file()})
        launcher.base.put(destination, 'summary.json', summary)
        print(json.dumps(dict(case=case, checks=checks, stages=observations, exit=result.get('exit'))))
        return 0 if all(checks.values()) else 1

if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(run(*sys.argv[1:]))

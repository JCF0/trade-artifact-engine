"""Synthetic-only custody, confined construction and TLS/cleanup checks."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('launcher', HERE / 'launch-successor.py')
launcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(launcher)
custody = launcher.custody

def run(destination):
    destination = Path(destination); destination.mkdir(mode=0o700)
    checks = []
    with tempfile.TemporaryDirectory(prefix='artifact-qualification-synthetic-') as directory:
        root = Path(directory); fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            def case(name, body, expected=None, mode=0o600):
                p = root / name; p.write_bytes(body); p.chmod(mode)
                try:
                    key = custody._read_named(fd, name, os.getuid())
                    assert expected is None and key == b'SYNTHETIC_QUALIFICATION_KEY_0001'
                    key[:] = b'\0' * len(key)
                except custody.CustodyStop as error: assert expected == str(error)
                checks.append(name)
            literal = b'HELIUS_API_KEY=SYNTHETIC_QUALIFICATION_KEY_0001\n'
            case('literal', b'UNRELATED_ENTRY=$(false)\n' + literal)
            case('quoted', b'export HELIUS_API_KEY="SYNTHETIC_QUALIFICATION_KEY_0001"\n')
            case('duplicate', literal * 2, 'CREDENTIAL_NAMED_ASSIGNMENT_AMBIGUOUS')
            case('missing', b'UNRELATED=not-a-provider-key\n', 'CREDENTIAL_NAMED_ASSIGNMENT_MISSING')
            case('expansion', b'HELIUS_API_KEY=$(false)\n', 'CREDENTIAL_NAMED_ASSIGNMENT_UNSUPPORTED')
            case('permissions', literal, 'CREDENTIAL_SOURCE_UNSUITABLE', 0o644)
            (root / 'link').symlink_to(root / 'literal')
            try: custody._read_named(fd, 'link', os.getuid()); raise AssertionError('SYMLINK_READ')
            except custody.CustodyStop as error: assert str(error) == 'CREDENTIAL_SOURCE_UNSUITABLE'
            checks.append('symlink-refused')
            os.link(root / 'literal', root / 'hardlink')
            try: custody._read_named(fd, 'hardlink', os.getuid()); raise AssertionError('HARDLINK_READ')
            except custody.CustodyStop as error: assert str(error) == 'CREDENTIAL_SOURCE_UNSUITABLE'
            checks.append('hardlink-refused')
            key = bytearray(b'SYNTHETIC_QUALIFICATION_KEY_0001')
            delivery = custody.deliver(root, key)
            try:
                st = os.fstat(delivery)
                assert st.st_uid == 65534 and st.st_nlink == 1 and st.st_mode & 0o777 == 0o400
                assert key == bytearray(len(key))
            finally: os.close(delivery)
            checks.append('private-capability-and-buffer-cleanup')
        finally: os.close(fd)
        # Disposable TLS fixture only, matching the existing accepted exchange test
        # mechanism. This is not a wallet/control key or a transaction signature.
        cert, key = root / 'synthetic-cert.pem', root / 'synthetic-tls-key.pem'
        subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-keyout', str(key), '-out', str(cert), '-subj', '/CN=mainnet.helius-rpc.com',
            '-addext', 'subjectAltName=DNS:mainnet.helius-rpc.com'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        received = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                # Never record a request target or headers, even for this synthetic key.
                length = int(self.headers['Content-Length']); assert length <= 1048576
                body = json.loads(self.rfile.read(length)); received.append(body['method'])
                assert body['method'] == 'getGenesisHash'
                raw = json.dumps(dict(jsonrpc='2.0', id=body['id'], result='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')).encode()
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try: result = launcher.run('local', destination / 'confined', server.server_port, cert.read_text())
        finally: server.shutdown(); server.server_close(); thread.join(timeout=2)
        summary = dict(custody_checks=checks, launcher=result, synthetic_server_methods=received, real_provider_requests=0)
        launcher.base.put(destination, 'local-summary.json', summary)
        print(json.dumps(summary))
        return 0 if result.get('exit') == 0 and result['released'] and not result['residual_pids'] and result['temporary_root_removed'] and received == ['getGenesisHash'] else 1

if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(run(sys.argv[1]))

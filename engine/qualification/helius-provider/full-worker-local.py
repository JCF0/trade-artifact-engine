"""Dedicated synthetic custody through the actual complete qualification worker.

Only filesystem-root redirection and the established synthetic TLS/public-input
fixture are instrumented. No replacement reader, key, delivery or worker.
"""
import importlib.util
import http.server
import json
import os
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def run(destination, selection):
    assert selection in ('complete', 'simulation-refusal')
    fixture = load('qualification_fixture', HERE / 'qualification-worker-local.py')
    launcher = load('full_launcher', HERE / 'full-launch.py')
    fixture.worker.launcher = launcher
    original_parse = http.server.BaseHTTPRequestHandler.parse_request
    def checked_parse(self):
        parsed = original_parse(self)
        if parsed:
            assert self.path == '/?api-key=SYNTHETIC_QUALIFICATION_KEY_0001'
            assert self.headers.get('Authorization') is None
        return parsed
    http.server.BaseHTTPRequestHandler.parse_request = checked_parse
    entry = load('synthetic_entry', HERE / 'credential-entry.py')
    with tempfile.TemporaryDirectory(prefix='artifact-full-dedicated-fixture-') as directory:
        root = Path(directory)
        (root / 'root').mkdir(mode=0o700)
        credentials = root / 'root/.artifact-qualification'; credentials.mkdir(mode=0o700)
        fd = os.open(credentials, os.O_RDONLY | os.O_DIRECTORY)
        try: entry._store(fd, bytearray(b'SYNTHETIC_QUALIFICATION_KEY_0001'))
        finally: os.close(fd)
        original = os.open
        def synthetic_open(name, *args, **kwargs):
            if name == launcher.custody.NAME:
                proof = original(root / 'dedicated-read-observed', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(proof)
            return original(str(root) if name == '/' else name, *args, **kwargs)
        os.open = synthetic_open
        try: code = fixture.run(Path(destination), selection)
        finally:
            os.open = original
            http.server.BaseHTTPRequestHandler.parse_request = original_parse
        assert (root / 'dedicated-read-observed').is_file()
        assert code == 0
    launcher.base.put(Path(destination), 'dedicated-coverage.json', dict(
        actual_complete_worker=True, dedicated_reader_observed=True,
        synthetic_root_removed=not root.exists(), real_credential_reads=0,
        external_requests=0, selection=selection))
    return code


if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(run(*sys.argv[1:]))

"""Dedicated synthetic file -> unchanged private FD5 -> confined diagnostic worker.

Runs the final frozen, dedicated-bound launcher without reader/delivery hooks.
Only diagnostic-local's synthetic filesystem root and TLS server are substituted.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
FROZEN = Path('/root/artifact-private-helius-provider-qualification/first-exchange-diagnostic-v1/runtime-successor-v1')
CANDIDATE = Path('/root/artifact-private-helius-provider-qualification/dedicated-credential-handoff-v2')


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def run(destination):
    recorder = load('runtime_recorder', FROZEN / 'run-local.py')
    before = recorder.verify()
    sources = json.loads((CANDIDATE / 'candidate-source.json').read_bytes())
    def verify_source():
        for path, digest in sources.items(): assert recorder.sha(Path(path)) == digest
    verify_source()
    fixture = load('fixture', CANDIDATE / 'harness/diagnostic-local.py')
    assert fixture.launcher.custody.SOURCE == '/root/.artifact-qualification/helius.env'
    code = fixture.run(destination, 'clean')
    proof = json.loads((Path(destination) / 'summary.json').read_bytes())
    assert proof['checks']['dedicated_reader_used'] and code == 0
    verify_source()
    after = recorder.verify(); assert before == after
    recorder.put(Path(destination) / 'runtime-stability.json', dict(before=before, after=after, stable=True))
    return code


if __name__ == '__main__':
    sys.exit(run(sys.argv[1]))

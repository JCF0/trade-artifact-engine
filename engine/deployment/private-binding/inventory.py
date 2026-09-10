"""Deterministic actual-host inventory; explicit output, no installs/imports of runtime code."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent


def canonical(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + '\n').encode()


def inventory():
    runtime = json.loads(subprocess.check_output(['node', str(HERE / 'resolve-runtime.mjs'), str(ROOT)],
        env=dict(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/nonexistent', npm_config_update_notifier='false')))
    members = {}
    def add(label, path):
        p = Path(path).resolve(strict=True)
        if not p.is_file():
            raise ValueError('non-file inventory member')
        data = p.read_bytes(); st = p.stat()
        members[label] = dict(path=label, resolved=str(p), bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), mode=st.st_mode & 0o777)
    baseline = ROOT / 'engine/docs/v1.3-supervised-repaired-integrated-source-manifest.sha256'
    sources = {r[66:] for r in baseline.read_text().splitlines()}
    sources.add(str(baseline.relative_to(ROOT)))
    sources.update(str(p.relative_to(ROOT)) for p in HERE.rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    for path in sorted(sources): add('source/' + path, ROOT / path)
    for index, package in enumerate(runtime['packages']):
        base = Path(package)
        for directory, names, files in os.walk(base):
            names[:] = sorted(n for n in names if n != 'node_modules')
            for name in sorted(files):
                p = Path(directory) / name
                add('dependency/%04d/%s' % (index, p.relative_to(base)), p)
    add('runtime/node', runtime['node'])
    add('runtime/python', '/usr/bin/python3')
    for directory, names, files in os.walk('/usr/lib/python3.12'):
        names[:] = sorted(n for n in names if n not in ('__pycache__', 'site-packages', 'dist-packages'))
        for name in sorted(files):
            if name.endswith(('.py', '.so')):
                p = Path(directory) / name; add('runtime/python-stdlib/' + str(p.relative_to('/usr/lib/python3.12')), p)
    # ELF closure is observed, not a template runtime/CA path. Include each linked
    # shared library recursively as well as libraries already mapped by Python.
    binaries = [runtime['node'], '/usr/bin/python3']
    binaries += [m['resolved'] for m in members.values() if m['resolved'].endswith(('.node', '.so'))
                 and Path(m['resolved']).read_bytes()[:6] == b'\x7fELF\x02\x01'
                 and Path(m['resolved']).read_bytes()[18:20] == b'\x3e\x00']
    libraries = set()
    while binaries:
        binary = binaries.pop()
        text = subprocess.check_output(['/usr/bin/ldd', binary], text=True, stderr=subprocess.STDOUT)
        for name in re.findall(r'(/[^\s()]+)', text):
            p = str(Path(name).resolve())
            if p not in libraries:
                libraries.add(p); binaries.append(p)
    for index, p in enumerate(sorted(libraries)): add('runtime/shared/%04d/%s' % (index, Path(p).name), p)

    return dict(version='artifact_private_executable_release_v1',
        predecessor_manifest_sha256=hashlib.sha256(baseline.read_bytes()).hexdigest(), node_version=runtime['node_version'],
        members=[members[k] for k in sorted(members)], resolution=runtime)


if __name__ == '__main__':
    destination = Path(sys.argv[1]); data = canonical(inventory())
    with destination.open('xb') as f: f.write(data)
    print(json.dumps(dict(path=str(destination), sha256=hashlib.sha256(data).hexdigest(), bytes=len(data), members=len(json.loads(data)['members']))))

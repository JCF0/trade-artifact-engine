"""Explicit offline qualification runner; never a deployment launcher."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import tarfile

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent


def snapshot():
    manifest = ROOT / 'engine/docs/v1.3-supervised-repaired-integrated-source-manifest.sha256'
    paths = {line[66:] for line in manifest.read_text().splitlines()}
    paths.add(str(manifest.relative_to(ROOT)))
    paths.update(str(p.relative_to(ROOT)) for p in HERE.rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    paths.update(str(p.relative_to(ROOT)) for p in (ROOT / 'engine/src/verification-scope-v1-3/final-proof-agent').rglob('*')
                 if p.is_file() and '__pycache__' not in p.parts)
    return {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in sorted(paths)}


def isolated():
    ns = os.readlink('/proc/self/ns/net')
    assert ns != os.environ['ARTIFACT_PARENT_NET_NS']
    links = json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', 'link']))
    routes = json.loads(subprocess.check_output(['/usr/sbin/ip', '-j', 'route', 'show', 'table', 'all']))
    routes6 = json.loads(subprocess.check_output(['/usr/sbin/ip', '-6', '-j', 'route', 'show', 'table', 'all']))
    assert len(links) == 1 and links[0]['ifname'] == 'lo' and 'UP' in links[0]['flags']
    assert all(r.get('dev') == 'lo' and r.get('type') in ('local', 'broadcast') for r in routes)
    assert all(r.get('dev') == 'lo' and r.get('type') in ('local', 'multicast') for r in routes6)
    status = Path('/proc/self/status').read_text()
    caps = {k: int(next(s.split(':')[1] for s in status.splitlines() if s.startswith(k + ':')), 16)
            for k in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']}
    assert caps == dict(CapInh=0, CapPrm=11, CapEff=11, CapBnd=11, CapAmb=0)
    assert 'NoNewPrivs:\t1' in status
    print('ISOLATION ' + json.dumps(dict(namespace=ns, links=links, routes=routes, routes6=routes6, capabilities=caps,
          no_new_privs=True, npm_update_notifier=os.environ['npm_config_update_notifier'])), flush=True)
    os.execvpe(sys.argv[2], sys.argv[2:], os.environ)


if __name__ == '__main__':
    if sys.argv[1] == '--prepare':
        assert os.readlink('/proc/self/ns/net') != os.environ['ARTIFACT_PARENT_NET_NS']
        subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True)
        os.execv('/usr/bin/setpriv', ['setpriv', '--bounding-set=-all,+chown,+dac_override,+fowner',
                 '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '/usr/bin/python3',
                 str(Path(__file__).resolve()), '--isolated', *sys.argv[2:]])
    if sys.argv[1] == '--isolated':
        isolated()
    destination = Path(sys.argv[1]); destination.mkdir(mode=0o700)
    command = sys.argv[2:]
    limit = 1800
    env = dict(PATH='/usr/local/bin:/usr/bin:/bin:/usr/sbin', HOME=str(destination / 'empty-home'),
               USERPROFILE=str(destination / 'empty-home'), npm_config_update_notifier='false',
               npm_config_audit='false', npm_config_fund='false', PYTHONDONTWRITEBYTECODE='1',
               ARTIFACT_PARENT_NET_NS=os.readlink('/proc/self/ns/net'),
               ARTIFACT_SUPERVISED_EVIDENCE_ROOT=str(destination / 'operational-exports'))
    actual = ['/usr/bin/unshare', '--net', '--pid', '--fork', '--kill-child=KILL',
              '/usr/bin/python3', str(Path(__file__).resolve()), '--prepare', *command]
    def put(name, value):
        (destination / name).write_text(json.dumps(value, indent=2) + '\n')
    before = snapshot(); put('source-before.json', before)
    with tarfile.open(destination / 'source-before.tar.gz', 'x:gz') as archive:
        for path in before: archive.add(ROOT / path, arcname=path, recursive=False)
    put('command.json', dict(command=command, actual=actual, cwd=str(ROOT), environment=env, timeout_seconds=limit))
    start = time.monotonic(); timed = False
    with (destination / 'output.tap').open('xb') as output:
        child = subprocess.Popen(actual, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT,
                                 start_new_session=True, close_fds=True)
        put('process.json', dict(pid=child.pid, pgid=child.pid))
        try:
            code = child.wait(timeout=limit)
        except subprocess.TimeoutExpired:
            timed = True
            os.killpg(child.pid, signal.SIGKILL)
            code = child.wait()
    after = snapshot(); put('source-after.json', after)
    import re
    data = (destination / 'output.tap').read_bytes()
    isolation_line = next((line[len(b'ISOLATION '):] for line in data.splitlines() if line.startswith(b'ISOLATION ')), None)
    isolation = json.loads(isolation_line) if isolation_line else dict(namespace=None, verified=False)
    residual = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit(): continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) == child.pid or os.readlink(path / 'ns/net') == isolation['namespace']:
                residual.append(int(path.name))
        except (OSError, ValueError): pass
    put('isolation.json', isolation)
    put('cleanup.json', dict(namespace_child_exit=code, residual_pids=residual,
        clean=not residual, pid_namespace_kill_child='SIGKILL', process_group=child.pid))
    totals = dict(re.findall(rb'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', data, re.M))
    result = dict(exit=code, timeout=timed, elapsed_seconds=time.monotonic()-start,
                  totals={k.decode(): int(v) for k, v in totals.items()}, source_unchanged=before == after,
                  tap_sha256=hashlib.sha256(data).hexdigest(), tap_bytes=len(data))
    put('result.json', result)
    print(json.dumps(result), flush=True)
    sys.exit(124 if timed else (code or (1 if residual or before != after or not isolation_line else 0)))

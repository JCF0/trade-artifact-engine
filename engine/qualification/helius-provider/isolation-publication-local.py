"""Deterministic local race regression of the actual drop() publication statements.
Only the publication AST is executed, with /evidence redirected to a temporary root.
No privilege, network or credential operation is invoked by this test.
"""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('base', HERE / 'supervise.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)

def run(destination, version):
    destination = Path(destination); destination.mkdir(mode=0o700)
    source = (HERE / 'launch-successor.py').read_text()
    if version == 'red':
        start = source.index("    pending = role + '-isolation-pending.json'")
        end = source.index('\ndef bridge', start)
        source = source[:start] + """    base.put(Path('/evidence'), role + '-isolation.json', dict(uid=os.getuid(), gid=os.getgid(),
        groups=os.getgroups(), caps=caps, keep_fds=keep, no_new_privs=True, core_limit_zero=True,
        pid_namespace=os.readlink('/proc/self/ns/pid'), net_namespace=os.readlink('/proc/self/ns/net'),
        host_signer_state_absent=True, high_fds_closed=True, environment=base.ENV))
""" + source[end:]
        expected = json.loads((destination.parent / 'worker-1/complete/harness-identity.json').read_bytes())['launch-successor.py']
        assert hashlib.sha256(source.encode()).hexdigest() == expected
    tree = ast.parse(source)
    drop = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'drop')
    start = next(i for i, n in enumerate(drop.body) if (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'pending' for t in n.targets))
        or (isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Attribute) and n.value.func.attr == 'put'))
    observed = []
    with tempfile.TemporaryDirectory(prefix='artifact-isolation-publication-') as directory:
        root = Path(directory)
        class Redirect(ast.NodeTransformer):
            def visit_Constant(self, node):
                if isinstance(node.value, str) and node.value.startswith('/evidence'):
                    node.value = directory + node.value[len('/evidence'):]
                return node
        fragment = ast.fix_missing_locations(Redirect().visit(ast.Module(body=drop.body[start:], type_ignores=[])))
        def slow_put(path, name, value):
            with (path / name).open('x') as f:
                # Deterministic observer at the exact open-before-write window.
                observed.append((root / 'worker-isolation.json').exists())
                json.dump(value, f); f.flush(); os.fsync(f.fileno())
        exec(compile(fragment, '<actual-publication-AST>', 'exec'), dict(Path=Path, os=os,
            role='worker', caps={}, keep=[5], base=types.SimpleNamespace(put=slow_put, ENV=base.ENV)))
        complete = json.loads((root / 'worker-isolation.json').read_bytes())
        passed = observed == [False] and complete['keep_fds'] == [5] and not (root / 'worker-isolation-pending.json').exists()
    result = dict(classification='SYNTHETIC_PUBLICATION_AST_ONLY', version=version, passed=passed,
        final_visible_during_incomplete_write=observed, launcher_sha256=hashlib.sha256(source.encode()).hexdigest(),
        temporary_root_removed=not root.exists())
    base.put(destination, 'result.json', result); print(json.dumps(result))
    return 0 if passed else 1

if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(run(sys.argv[1], sys.argv[2]))

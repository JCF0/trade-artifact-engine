# Dedicated Artifact qualification credential handoff (v2)

## Observed source mapping

Private inspection of `/usr/local/sbin/start-rusty` found a fixed `ENV_FILE` of
`/root/.openclaw/.env`. It unsets inherited `HELIUS_API_KEY`, parses one named
literal assignment as data, exports the parsed value and execs
`/usr/local/bin/hermes`. The directly referenced file contains the named field.
No alternate source was observed in this wrapper. The wrapper was not executed
or sourced. No secret values, credential-bearing URLs, environment dumps or
credential hashes were retained.

Historical `custody.py:read_authorized_key()` traverses `/root/.openclaw` and reads
`.env` directly; `SOURCE` is descriptive, not an environment override. TUI
injection cannot change this explicit source-to-FD5 path. This mapping does not
explain the observed HTTP 401 or establish that any key is valid.

## Prepared support, not activation

The current `diagnostic-launch.py` now explicitly imports `artifact-custody.py`.
Its live and diagnostic-local branches share `deliver_dedicated()`. Historical
frozen launchers, accepted production files, and consumed reservations are not
modified. TUI environment injection cannot override the dedicated fixed path.

- `artifact-custody.py`: API-compatible dedicated reader and unchanged delivery
  implementation, fixed to `/root/.artifact-qualification/helius.env`. No fallback,
  CLI path selection, or environment credential lookup. Parent traversal refuses
  symlinks; dedicated directory must be root:root 0700. Existing named-data parser
  requires a single-link root:root regular file with exact mode 0600.
- `credential-entry.py`: operator-only interactive creation. Requires root and a
  controlling terminal, disables core dumps/process dumpability, obtains and
  confirms hidden input, validates the existing credential grammar, and uses
  exclusive no-follow creation of `helius.env.pending`. It writes
  `HELIUS_API_KEY=<value>` as data, fsyncs the staging file and directory, and only
  then exclusively hard-links the complete inode to `helius.env`. On normal
  success it removes the staging link and fsyncs the directory again. This uses
  the isolation-report publication mechanism, not overwrite-capable rename.
  No key in argv, environment or shell command history.
  No echoing getpass fallback. Existing file/symlink is refused, never overwritten.
  Before publication, failed/incomplete writes leave only the staging name.
  After publication, an error can leave a complete, parseable final file: that
  does NOT establish successful entry. No error path deletes, overwrites or
  retries anything. Either existing name blocks another invocation. Normal
  staging-link removal is publication housekeeping, not failure recovery.
  Python string copies are not guaranteed fully zeroizable.

Run exactly this in a trusted **root terminal**, not in chat or a recorded/shared
terminal session. Do not add the key as an argument:

```sh
if /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/python3 -I -B /root/artifact-private-helius-provider-qualification/dedicated-credential-handoff-v2/harness/credential-entry.py; then printf '%s\n' 'ARTIFACT_ENTRY_EXIT=0'; else printf '%s\n' 'ARTIFACT_ENTRY_UNCONFIRMED: STOP; do not use or retry.'; fi
```

The operator creates and enters the dedicated key. Preparation did not create the
real dedicated file, copy an existing key, or change any existing credential.

**Confirm success only by observing BOTH in this same invocation:**

1. `ARTIFACT_CREDENTIAL_ENTRY_PUBLISHED: no request sent.` from the helper.
2. `ARTIFACT_ENTRY_EXIT=0` from the shell's successful-exit branch.

Then report only: "I observed both success messages in the same invocation."
Do not paste the key, file contents, URL, key hash, or environment. That statement
confirms entry only; it does not authorize a diagnostic request.

If either message is missing, the terminal disconnects, exit is nonzero/unknown,
or any error occurs: STOP. Do not use the credential, rerun the command, inspect
the key to infer success, delete either name, or overwrite anything. Require
separate explicit recovery instructions. Even a complete parseable file is not
evidence that the operator observed successful completion.

## Verification retained

Current evidence and frozen harness:
`/root/artifact-private-helius-provider-qualification/dedicated-credential-handoff-v2/`.

- `credential-publication-local.py`: ten focused cases, including a reproduced
  predecessor partial-write publication RED; write, file/directory fsync, link,
  lost-publication-acknowledgment and unlink failures; short writes; normal
  success; and a competing final-name creation. Every case also checks rerun
  refusal without deletion/overwrite and input-buffer wiping. All passed.
- `diagnostic-custody-local.py`: nine missing/invalid confirmation records refused,
  including file-existence-style assertions, plus one valid explicit operator
  confirmation accepted. No credential reading occurs in these gate checks.
- `credential-entry-local.py`: six synthetic checks including an actual disposable
  controlling terminal with echo disabled during both prompts, root:root 0600
  output, exclusive creation, symlink refusal, invalid-key refusal and no-terminal
  fail-closed behavior. The actual terminal check also requires the helper's
  success marker and exit zero. All passed on the frozen v2 helper.
- `artifact-delivery-local.py`: actual qualified runtime/launcher and diagnostic
  worker exercised through the final dedicated-bound launcher. The synthetic
  file is created by the real staged publication function. No reader/delivery
  hook replaces the launcher path: only filesystem-root redirection and local
  TLS fixtures are test instrumentation. The delivered key is preserved when
  synthetic CA material is added. Ten assertions passed, including dedicated
  reader observation, screening, TLS/SNI, confinement and cleanup. One local
  request, zero real credential reads, zero external requests. Runtime and full
  candidate source identities matched before/after.

Earlier frozen harness, source/runtime pins, diagnostic READY/reservation/outcome
and historical evidence remain unchanged. No canonical suite or unrelated
successful selection was repeated. Prior preparation and review evidence remain
at `dedicated-credential-preparation-v1/`; v2 predecessor copies and RED results
are retained separately. One tool approval expired without execution; after
explicit renewed consent the pending focused checks completed. No general
review cycle was started.

## Exact next launch requirements

1. Operator enters and confirms the new dedicated key as specified above. Entry
   neither validates provider entitlement nor grants an external allowance.
2. Obtain explicit new bounded external authorization. Both previous allowances
   remain consumed; never delete/reuse their reservations or READY records.
3. The dedicated-bound successor is already prepared at
   `dedicated-credential-handoff-v2/harness/diagnostic-launch.py`, with complete
   candidate source bindings in `candidate-source.json`. Do not use the old
   launcher. No new READY, reservation or external allowance was created.
4. Verify current installed runtime and complete readiness-map coverage against
   the final frozen bytes. Reuse matching evidence; check changed binding through
   the retained synthetic actual-launch coverage. Any drift or incomplete
   binding remains a blocker; successful parsing alone is never an entry gate.
5. Before credential reading, durably reserve only the newly authorized allowance.
   Keep the named file-to-private-FD5 route, 5-second request/60-second launch
   limits, TLS verification, screening, fixed endpoint, zero retries/redirects,
   confinement and cleanup. No key/value hash belongs in readiness evidence.

The new session evidence root is
`dedicated-credential-handoff-v2/diagnostic-session`. Its future `READY.json` must
contain `credential_entry` with exactly: `source` equal to
`/root/.artifact-qualification/helius.env`, `operator_confirmed` true, integer
`exit` 0, and `marker` equal to `ARTIFACT_CREDENTIAL_ENTRY_PUBLISHED`. Populate
this only from the operator's explicit confirmation, never from a file probe,
parser result, helper rerun or environment. The launcher checks it before
reservation and credential reading. Separate newly granted external authority,
complete file identities and all existing diagnostic gates are still required.

No external request, production acceptance, activation, signing, broadcast or Git
mutation is authorized or performed by this preparation.

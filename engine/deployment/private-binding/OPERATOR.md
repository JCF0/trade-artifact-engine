# Disabled private binding — operator contract

This is a **candidate**, not a deployment or execution authorization. Existing `run-wiggles-supervised-v1.mjs` and `createArtifactFinalProofLiveExecutorV1` remain unchanged and mechanically disabled. The additional `worker.mjs` also stops unconditionally in `requireActivationV1`, before reading credential bytes or opening authority. There is no enable flag. Do not bypass it by invoking an offline constructor with a production wallet.

## Trust and installation contract (not performed)

Trusted administration supplies an immutable release, fixed Node executable, closed public configuration, and all inherited descriptors. The controller and executor must be distinct unprivileged identities with no sudo, ptrace, debugger, core-dump or release-write capability. A root-capable Hermes process is not an eligible controller. The same-UID fixtures establish protocol behavior, not this confinement. No accounts, services, production directories or permissions were provisioned by this build.

Proposed installation root is `/opt/artifact/release`, configuration custody `/etc/artifact-wiggles`, private episode custody `/var/lib/artifact-wiggles`. These are future administrator choices requiring a newly inventoried installation; the current inventory records actual source/runtime paths beneath `/root`, not a fictitious installed layout. Do not relax `/root` permissions. Administrator-owned release/configuration ancestors must not be replaceable by either application identity. Executor-owned private directories are 0700; regular single-link state and evidence files are 0600; key custody is the existing runtime's 0400/0600 contract. Restoring a valid older snapshot remains outside automatic detection and requires STOP.

## Literal worker contract

After a separately approved installation and activation change, the proposed command is the installed pinned Node executable, `--openssl-config=/opt/artifact/release/engine/deployment/private-binding/openssl.cnf`, then `/opt/artifact/release/engine/deployment/private-binding/worker.mjs`, with **no application arguments**. Cwd is the immutable release root. This is not presently runnable for trading. The source currently accepts no application selector and still unconditionally refuses valid public inputs.

The administrator must establish: `umask 077`; `RLIMIT_CORE=0`; no inspector/preload/loader flags; an empty supplementary-group set unless separately justified; no unexpected inherited descriptors; no socket/proxy/debugger environment. Allowlisted environment keys are only `PATH`, `HOME`, `USERPROFILE`, `LANG`, `LC_ALL`, `TZ`. Pin their values at installation: release runtime/system tools only in PATH, nonexistent HOME/USERPROFILE, `C.UTF-8` locale, `UTC`. No `NODE_OPTIONS`, `NODE_PATH`, TLS override, credential, proxy or update-check environment. The worker enforces the environment-key/argv checks, but administration must enforce cwd, exact runtime flag value, rlimits, descriptor closure and privilege isolation. These host preconditions have not been cross-UID qualified.

The finite supervisor routine owns ordinal progression (1 then 2); channel JSON cannot choose an operation, ordinal, path, transport, clock, wire, quantity or command. It stops new admission on channel loss, authenticated revocation, deadline or failure. An external trusted process supervisor must enforce a hard whole-process deadline and collect/terminate descendants if filesystem/kernel operations do not settle. The JS timer is not a hard guarantee against blocked kernel I/O. `qualify.py` implements a namespace-wide hard deadline for offline verification only; it is **not a production launcher**. Production external-supervisor/UID qualification remains an explicit host gate.

### Inherited descriptor table (worker perspective)

| FD | Direction/type | Custody and content |
|---|---|---|
| 0 | No input | `/dev/null`; not a controller command channel. |
| 1, 2 | Output | Administrator-controlled bounded diagnostic capture; generic STOP diagnostics only. |
| 3 | Read-only regular file | Administrator-owned canonical public binding JSON; at most 262144 bytes; no group/other write. |
| 4 | Read-only regular file | Administrator-owned canonical executable-release inventory R; at most 33554432 bytes; no group/other write. |
| 5 | Read-only regular file | Executor-owned private credential capability, at most 73728 bytes, no group/other access; never supplied by controller. |
| 6 | Input pipe | Acquisition: exactly one authenticated canonical decision then EOF. |
| 7 | Output pipe | Acquisition challenge. |
| 8 | Output pipe | Narrow acquisition decision result. |
| 9 | Input pipe | Disposal: exactly one authenticated canonical decision then EOF. |
| 10 | Output pipe | Disposal challenge. |
| 11 | Output pipe | Narrow disposal decision result. |
| 12 | Separate input pipe | Human-signed revocation, one bounded envelope then EOF; not owned by the agent. |
| 13 | Separate output pipe | Current public predecessor context for the human custodian. |
| 14 | Separate output pipe | Durable human revocation acknowledgment or non-acknowledgment STOP. |
| 15 | Output pipe | Final non-secret operational disposition and package manifest digest, if durable. |

All FD identities must be distinct. Anonymous pipes are preferred; the implementation also admits socket descriptors, whose peer custody/direction must be established by administration. Decision/human envelopes are at most 131072 bytes. Decision waits are configured in [1,60000] ms, whole episode in [1,600000] ms and no later than the existing runtime deadline. Input is canonical JSON with the existing serializer's trailing LF; duplicate/conflicting concatenated documents refuse. `writeFrameV1` emits canonical JSON plus a separator LF (thus two terminal LFs); consumers must use the frame boundary, not parse each pretty-printed line as JSON. Outputs are bounded to 131073 bytes per frame and 1000 ms per write. Context updates are distinct-only, polled at 100 ms, at most 32 frames. Close unused descriptor ends so EOF and EPIPE are meaningful.

Only the controller receives FDs 6–11 peers; only the human custodian receives FDs 12–14 peers. Neither receives FD 5, state roots, wire, or the trusted runtime object. Output acknowledgment means durable authority plus wrapper retention, not merely successful delivery. Missing output is ambiguous; it never permits replacement signing, send resumption or reprovisioning. The finite session admits one human envelope; exact revocation replay is an existing authority operation for separate trusted reconciliation, not another controller action.

## Public configuration and private provider capability

`binding.mjs` accepts exactly `version`, `release_sha256`, `runtime`, `provider_capability_id`, `decision_timeout_ms`, `episode_timeout_ms`. Version is `artifact_private_binding_v1`; the runtime object uses the unchanged production schema, mandate, human authorization and four-phase budgets. R equals both release fields. No executable module is loaded from JSON. Ordinary composition verifies prior provisioning and opens existing journal/authority only.

FD 5's canonical private object has exactly `capability_id`, `endpoint`, `bearer`, `ca`. The capability ID must match the public mapping. Production exchange requires HTTPS; URL userinfo, query and fragment are refused. Bearer authentication is fixed. Explicit CA PEM is bounded to 65536 bytes; null uses Node's configured trust, which must be qualified with the installed runtime. No live capability or secret is required to build this candidate. Do not place these values in argv, logs, public C, chat, or controller environment.

The public mapping is `{capability_id, scheduler_label: 'OFFLINE_INJECTED_PRIMARY_SOLANA_RPC', transport_retries: 0}`. The scheduler label remains historical compatibility data, not a URL. `fixedRpcAdaptersV1` alone maps it to the private origin, preserving request bytes and protected scheduling. One direct Node HTTP(S) ClientRequest is created per request, with no pooled connection reuse, proxy selection, redirect following, retry or fallback. A single monotonic absolute request deadline encloses DNS/connect/TLS/headers/body, so no phase resets its budget. Header ceiling is 16384 bytes; streamed bodies use the minimum exchange/phase limit. Only status 200, uncompressed UTF-8 JSON is admissible. The readiness adapter serializes the retained object canonically; source/simulation bytes must match that serialization; submission forwards the exact supplied Buffer.

Contaminated response bytes (credential/endpoint echoes, including tested escaped forms) are rejected before retention. They are not rewritten into allegedly exact evidence; missing admissible evidence is STOP. This mechanism and synthetic canary tests are not a proof that an arbitrary malicious provider cannot encode a secret in another form. Provider credential placement/echo behavior, DNS/TLS trust and full-history/minContextSlot semantics remain separate custody/provider gates.

## Explicit provisioning and lost state

Administrator-only library operation: `provisionPrivateBindingV1(validatedRuntimeConfiguration)` from `provision.mjs`. It is not invoked by worker startup and has no automatic CLI dispatch. It requires an explicitly prepared empty private episode directory and production-valid public configuration. It creates and syncs an exclusive started marker, provisions the existing SQLite authority and journal, then creates/syncs/verifies completion. A partial attempt preserves files and records STOP where storage permits. No repair, deletion, replacement authority or enrollment is performed on reopen. Missing completion, a stopped tombstone, missing/corrupt head or known loss prohibits launch. The administrator must also retain the out-of-band successful provisioning acknowledgment: total storage failure can prevent even a failure tombstone.

Retain main DB **and WAL/SHM**, head, markers, requests, simulation, wire, submissions and partial exports. Opening/closing authority can checkpoint SQLite and is not a forensic read-only operation. Custodians must preserve quiescent state before a separately authorized recovery action. After-window reconstruction is offline; this constructor does not extend acquisition or runtime windows to reopen execution.

## Publication and independent replay

`publishRetainedPackageV1` wraps the unchanged exporter, validates its fixed destination and package, syncs the **parent state directory**, then validates again before acknowledging. `copyPublishedPackageV1` is a separate custodian-only exclusive copy: exact original members and manifest, member fsync, child fsync, parent fsync, source/destination validation. Partial destinations remain, including on failure. Never overwrite or retry into an existing child. Unselected and digest-selected packages remain separate; selection must use the independently derived population/member digests.

Source-supported fresh verifier invocation (public arguments only): `/usr/bin/python3 engine/deployment/private-binding/verify-isolated.py INVENTORY_PATH R PACKAGE_ROOT MANIFEST_SHA256 EVIDENCE_KIND`. Use the exact installed script path after deployment; no controller may supply these trusted custody arguments. Synthetic fixtures use `SYNTHETIC_FINAL_EPISODE`, never a real occurrence label. Before replay, the launcher verifies release member bytes and requires Linux x86-64 Landlock ABI >=3. Before confinement it calls libc/Linux `close_range(3, UINT_MAX, 0)`: all inherited FDs >=3 are closed immediately, including descriptors above subsequently lowered soft/hard resource limits. This requires libc/kernel close_range support; missing support or any call failure stops before confinement/reconstruction, with no partial-range fallback. Custodian-owned standard streams 0–2 are preserved: stdin must be `/dev/null`, stdout/stderr exclusively captured by the custodian, never an authority/network capability. The launcher disables core dumps, confines reads to inventoried files and admitted package members, denies package writes, denies socket/ptrace/process-memory/io_uring operations with seccomp, and executes the pinned Node with an empty environment and `/tmp` cwd. The custodian must bind the expected manifest out of band. All replay output is reconstruction, not approval or replacement authority.

## Non-circular identities

R is SHA-256 of the exact canonical `artifact_private_executable_release_v1` inventory emitted by `inventory.py`. The preimage binds source, predecessor manifest, resolved package closure and resolution edges, Node version/build/executable, Python stdlib/executable and ELF-linked libraries. Paths, resolved paths, lengths, hashes and modes are explicit. R is not inside its own preimage. The inventory is written outside the scanned source tree. Optional unresolved packages are explicitly listed, never installed. This actual-host inventory is not an attestation of production ownership or a relocatable `/opt` release. Relocation, activation, dependency or runtime change requires a new R. The inventory generator's conservative package closure is not permission to invoke every inventoried module.

C is SHA-256 of the exact canonical public binding bytes **after** R, authentic mandate/authorization, paths and finite windows are finalized. The existing runtime's `executor_release_sha256` binds R. Public C has only a provider capability ID, not private endpoint or credential bytes. C has no own-digest field. No production C is fabricated for this disabled build.

D is SHA-256 of canonical JSON `{version: 'artifact_private_deployment_identity_v1', release_sha256: R, public_configuration_sha256: C, host_contract_sha256, custody_attestation_sha256, provider_qualification_sha256}`. Each attestation is a separately frozen public record; approval is external, never a field hashed into its own authorization. The host contract names actual installed paths, UIDs, groups, descriptor topology, environment, cwd, hard supervision and storage policy. D is not inserted back into R or C. Without production C and qualified attestations there is no production D. A disabled candidate source/runtime identity can be frozen now without inventing these later human inputs.

## Eventual activation change — description only

After installation/custody/provider qualification and independent approval of exact future bytes, a separately reviewed change would connect the administrator launcher to the private composer and remove/replace the unconditional activation refusal under an explicit approved launch contract. It must address the existing live entry points deliberately, not add an environment toggle or call a fixture constructor. This necessarily changes R, then C and D and the human authorization. No such diff is applied here; approval of this disabled candidate cannot authorize an enabled successor.

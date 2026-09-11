# Helius qualification successor — LOCAL GREEN, BLOCKED BEFORE EXTERNAL DISPATCH

This is a successor to the original `RUN-PLAN.md` and immutable
`/root/artifact-private-helius-provider-qualification/external-session/run-spec.json`
(SHA-256 `2fef59e4b5a35a23de503f70f94e49ba794430e28841a20db354bac0df1926fc`).
Neither that specification nor its NOT_DISPATCHED ledger is replaced. There remains
ONE unused external session, not one allowance per plan. No provider dispatch is
permitted until authentic setup provenance, the full public input, local coverage
and final launch identities have been bound before release.

## Scope and current blocker

The permitted credential source is exactly `/root/.openclaw/.env`, named literal
`HELIUS_API_KEY`. Custody checks no-follow directory/file opens, ownership, mode,
link count, size and before/after identity. It rejects missing/ambiguous/unsupported
assignments without evaluating them. Only the named value enters private FD 5;
no argv/environment delivery or secret-bearing diagnostic is permitted. Actual
source metadata was suitable, but the actual key has not been read: no real worker
is needed before the remaining public-evidence gate can pass.

The recovered September 5 r13 archive is the SETUP PROCEDURE, not executed setup.
Its seven member names contain no final-wallet execution report. Its six embedded
checksums match the available procedure members. Its observed archive digest is
`f8da43e28ce5f9d0bdd0372ce9eee56f343ff990e58877847e26c4fc567b3868`;
this must NOT be substituted for `setup_archive_sha256` in a real descriptor.

Missing: authentic executed `setup-freeze.json`, the public wallet manifest,
ATA/funding finalized records with their setup signatures, referenced evidence
manifests and the actual execution-evidence archive. The procedure names the public
root `$HOME/.artifact-calibration-local/v1/public/final-proof-wallet/` on Wiggles;
its `/root`-home counterpart is absent locally. No secret sibling was searched.
The bounded `/root/artifact-*` metadata/public-report search did not recover these
records. This is scoped non-recovery, not proof that the records do not exist.

## Revised exact maxima and parameter derivation

All RPCs use the unchanged accepted fixed Helius query-authentication exchange.
Sequential dispatch, no transport retry, fallback endpoint, auth negotiation,
automatic restart, submission or broadcast. Requests are durably reserved first.

| Method | Maximum | Parameters / derivation |
|---|---:|---|
| getGenesisHash | 1 | `[]`, fixed mainnet genesis equality. |
| getSlot | 1 | Finalized anchor A. |
| getBlock | 1 | A; finalized, transactionDetails none, rewards false, maxSupportedTransactionVersion 0; safe nonfuture time at most 300 seconds old. |
| getMultipleAccounts | 2 | First wallet/JUP ATA/USDC ATA at floor A. Second pool, three directional tick PDAs, JUP/USDC vaults, oracle, JUP/USDC mints; base64/finalized with preceding pool-read floor. |
| getTokenAccountsByOwner | 2 | Classic and Token-2022 program filters, opening floor; exact expected population and equal opening watermarks or STOP. |
| getSignaturesForAddress | 15 | Each wallet/ATA: at most four scan pages plus repeated head; limit 100, finalized, opening floor, exact last-signature cursor, explicit empty exhaustion, stable repeated head. |
| getAccountInfo | 1 | Fixed pool, base64/finalized/opening floor. Decode accepted fixed layout and derive three acquisition tick PDAs. |
| getTransaction | 2 | Two distinct authentic recovered setup signatures only; finalized, encoding json, maxSupportedTransactionVersion 0. Require nonnull successful bodies matching requested signature, relevant public accounts and setup time bound. These checks sample bodies; they do not independently reconstruct all setup effects. |
| getLatestBlockhash | 1 | Finalized, current route context floor; retain original hash/last-valid height. |
| getFeeForMessage | 1 | Exact supported-builder message, finalized, original blockhash context floor; equality to truthful recovered fee constraint, no retry. |
| getBlockHeight | 1 | Finalized, exact fee-response context floor; require below retained last-valid height. |
| simulateTransaction | 1 | Exact unsigned acquisition wire, base64, finalized, sigVerify false, replaceRecentBlockhash false, fee-response context floor. All signatures zero. |
| All others | 0 | Every submission/broadcast/bundle method forbidden. |

Maximum **29 requests** (original 25 plus two setup bodies, one exact fee and one
unsigned simulation). The route multiple-account call now carries dynamic ticks
and static route accounts together. The quota is not transferable between methods.
If authentic records require more setup-body calls, revise the frozen specification
before dispatch within the original ceiling; never skip the simulation objective.

Retain stricter **5,000 ms/request**, **1 MiB/request and response**, **16 MiB aggregate
admitted responses**, **55-second inner sequence**, **60-second outer launch limit**,
within the original 40-call/two-simulation/600-second ceilings. Stop on contradiction
or exhaustion, including context mismatch. No follow-up diagnostic calls.

## Non-authoritative construction

`construction.mjs` uses accepted fixed pool/tick decoders, `swapQuoteByInputToken`
and `buildOrcaMessageBoundaryV1`; it does not call readiness admission or authority
state. Only acquisition is represented, so no fabricated acquired disposal balance
is needed. The descriptor must be complete, truthful and externally classified
`QUALIFICATION_ONLY_NO_AUTHORIZATION_OR_ELIGIBILITY`, with live readiness unresolved.
No approval or eligibility follows from its structural hash. Quotes derive from
current admitted route bytes; exact message fee is corroborated, never invented.

The preserved local test uses explicitly synthetic public descriptor fields and
retained calibration route bytes as fixture inputs. Its quote/message results are
NOT current final-wallet observations or authentic setup provenance.

## Custody/network binding and limits of verification

`launch-successor.py` uses a new private PID/mount domain. Broker, relay and worker
all drop to existing UID/GID 65534 with empty groups, zero capabilities,
no_new_privs, zero core limits, chroot and seccomp. The worker and relay have a
private loopback-only network namespace. A credential-blind unprivileged broker
connects only to the fixed hostname/443 (local mode substitutes a numeric-loopback
synthetic TLS fixture); it passes a connected descriptor to the relay. TLS remains
end-to-end between accepted Node exchange and provider. Worker retains only 0–2/5;
broker/relay retain only explicit transport capabilities, not FD 5. No host signer,
credential store, trading state or host process namespace is mounted.

New temporary resolver files are readable mode 0444; no existing file permissions
change. The broker uses one existing resolver, one resolver attempt and the first
IPv4 destination only, without address fallback. Synthetic local TLS proved the
relay and fixed hostname verification path, not external DNS/provider availability.

Parent records isolation and process identity before release. At deadline it kills
the owned process group/PID-namespace init and checks retirement, including an
escaped-session descendant. Temporary credential material and the owned jail are
removed after retirement; partial evidence is retained.

The tested local driver is `local-successor.py`, NOT npm/canonical acceptance.
The corrected `local-2` passed nine custody checks and nine construction/boundary/TLS
checks; the separate cleanup probe passed. Original `local-1`, expired approval and
terminal lifecycle-guard failures remain history. No successful selection is rerun
merely to satisfy an automated canonical-test notice.

The final live entry `worker-successor.mjs` is separate from accepted R and was
added after the local driver GREEN. Its syntax is checked separately; the full
live-input/setup/probe composition is NOT claimed exercised by that local result.
No READY record, authentic public input or live session reservation has been made.
A truthful input bundle and complete composition check remain gates before release.

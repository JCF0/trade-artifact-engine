# `receipt_package_v1` filesystem-store operations

## Scope and safety boundary

`createReceiptPackageFsStore({ root, faultInjector })` is the Slice 2 storage adapter for an already-built `receipt_package_v1`. It performs no acquisition, orchestration, inventory update, archive/economics mutation, public-demo generation, network access, upload, mint, or signing.

`root` is mandatory, must already exist as an administratively provisioned directory, and must be durable before the store is used. The adapter has no default and never selects `engine/data` or any production directory. Callers must supply a dedicated package root. Requiring a pre-existing root avoids claiming that a newly created root entry is durable without syncing its whole parent chain. Tests create a new operating-system temporary directory for every case.

The supported production platform is the Linux VPS with GNU coreutils `mv` at `/usr/bin/mv` and a local filesystem that supports regular-file `fsync`, directory `fsync`, atomic same-filesystem no-clobber directory rename, exclusive creation, and `O_NOFOLLOW`. Publication invokes `mv --no-clobber --no-copy --no-target-directory`; on the supported Linux target this uses the kernel no-replace rename path and never falls back to a cross-filesystem copy. Staging and committed directories are siblings under the same explicit root, so publication never crosses a filesystem boundary. Development tests exercise these semantics on the local temporary filesystem, including a destination created after inspection but before publication. Missing required flags/tools or a filesystem that reports directory-sync semantics as unsupported fails with `durability_unavailable`; the adapter does not report a durable commit after a silent downgrade.

## Disk layout

For receipt hash `<receipt_hash>`:

```text
<root>/
  <receipt_hash>/                         # visible committed package
    manifest.json
    canonical-receipt.json
    verification.json
    archive-record.json
    economics.json

  .<receipt_hash>.<random-uuid>.tmp/       # one writer's hidden staging directory
    manifest.json
    canonical-receipt.json
    verification.json
    archive-record.json
    economics.json

  .<receipt_hash>.lock/                    # transient adapter-owned commit lock
```

Committed and staging directories are created with mode `0700`; members are created exclusively with mode `0600`. Existing process umask may remove permissions but cannot add them. No index is created. UUIDs, lock identities, local paths, timestamps, and runtime/job provenance never enter member bytes or `package_digest`.

Readers address only the exact non-hidden `<root>/<receipt_hash>/` directory after validating the lowercase 64-hex receipt hash. They never scan hidden staging or lock entries. A committed result is returned only after all five entries are regular non-symlink files, the member set is exact, every file parses, the complete package validator passes, and every file is byte-for-byte equal to the existing canonical serializer output. Missing, extra, nested, special, symlinked, noncanonical, malformed, or inconsistent committed content fails closed as `committed_package_invalid`.

## API

```js
const store = createReceiptPackageFsStore({ root, faultInjector });

await store.inspect(receiptHash);
await store.stage(receiptPackage);
await store.validateStage(stagingHandle);
await store.commit(stagingHandle, { expectedPackageDigest });
await store.abort(stagingHandle);
await store.readCommitted(receiptHash);
```

`readCommitted()` returns `undefined` when the exact committed directory is absent and otherwise returns the complete validated package object. `location` values are operational return data only; they are never serialized into a package.

Staging handles are opaque object capabilities registered in a store-private `WeakMap`. They contain no caller-editable path. A handle from another store or a caller-created lookalike is rejected. The adapter records the staging directory's device and inode and rechecks both before validation, cleanup, and publication. Abort and unchanged cleanup can therefore remove only the exact staging directory owned by that handle. Abort never removes a committed directory. Abandoned hidden stages remain reader-invisible; stale-stage cleanup is deliberately deferred.

## Stage transaction and durability

`stage()` performs these steps:

1. run the complete existing package validator against the input;
2. serialize all members only with `serializeReceiptPackageV1()`;
3. exclusively create one hidden UUID staging directory under `root`;
4. exclusively create and write exactly the five members;
5. `fsync` each open member after its complete write;
6. `fsync` the staging directory;
7. enumerate the directory without following member symlinks;
8. open each expected member with `O_NOFOLLOW`, read it back, and parse it;
9. run the complete existing package validator over the reconstructed package;
10. require exact canonical bytes and the original receipt hash/package digest.

A failed stage is never visible as committed. Its hidden partial directory may remain as failure evidence because no valid opaque handle can be returned after a failed call. Operations staff may remove abandoned stages only under a separately reviewed stale-stage procedure in a later slice.

## Commit locking and non-replacement

Commit uses an exclusive hidden directory lock named `.<receipt_hash>.lock`. All adapters using this store implementation contend on that same lock across async calls, worker threads, and processes. Acquisition retries bounded contention and fails as `package_store_locked` rather than exposing raw `EEXIST`/`ENOTEMPTY` races. The lock is removed in `finally`, and the root is fsynced again so successful lock deletion is durable before a response. Lock cleanup failure is explicit (`package_store_locked` before publication, `commit_unknown` after publication). A process that dies while holding a lock leaves a fail-closed lock for administrative reconciliation; this slice does not guess that a lock is stale or steal it from a potentially live publisher.

The lock covers stage ownership/readback validation, destination inspection, conflict selection, rename, parent-directory `fsync`, and final committed-package reconciliation. No destination-absent observation made before acquiring the lock is trusted.

Within the lock:

- absent destination: publish the complete staging directory with the Linux no-clobber/no-copy rename operation to `<root>/<receipt_hash>`, `fsync(root)`, then reread and validate the committed package;
- same validated digest: remove only this handle's staging directory and return `unchanged`;
- different validated digest: preserve committed content and staging evidence, then throw `package_store_conflict`;
- malformed/invalid destination: preserve both sides and throw `committed_package_invalid`.

The adapter never removes or recursively replaces a committed directory. The per-receipt lock serializes cooperative publishers, while the no-clobber rename independently prevents replacement if a destination appears after locked inspection. The adapter then reconciles that destination instead of exposing a raw filesystem race or blindly replacing/retrying.

## `commit_unknown` and reconciliation

Once atomic rename succeeds, any failure before a confirmed response—including injected failure immediately after rename, failure before/while parent-directory sync, failure after parent sync but before response, or failure to durably remove the lock—returns:

```js
ReceiptPackageStoreError {
  code: 'commit_unknown',
  receipt_hash,
  expected_package_digest
}
```

The caller must not blindly rename the old handle again. The handle is no longer a staging capability. Reconcile with:

```js
const state = await store.inspect(error.receipt_hash);
```

Then:

- `committed` with the expected digest: publication succeeded; treat the operation as committed/unchanged success;
- `absent`: no package is visible, so build/stage a new package and retry publication safely;
- `committed` with a different digest: report `package_store_conflict` and preserve evidence;
- `committed_package_invalid`: fail closed and require administrative investigation.

## Stable error codes

The adapter throws `ReceiptPackageStoreError` with stable `code` values:

- `explicit_package_root_required`
- `malformed_receipt_hash`
- `invalid_receipt_package`
- `staging_create_failed`
- `staging_write_failed`
- `staging_validation_failed`
- `staging_handle_invalid`
- `staging_ownership_lost`
- `package_store_locked`
- `package_store_conflict`
- `committed_package_invalid`
- `commit_unknown`
- `durability_unavailable`
- `abort_failed`
- `unexpected_store_entry`

Structured details use receipt/package identities and, only where operationally necessary, the returned local `location`. Package member bytes never contain these details.

## Fault-injection contract

When supplied, `faultInjector(point, context)` may synchronously throw or return a rejecting promise. Points are:

```text
before_staging_directory_create
after_member_write                         context.member identifies each of five members
after_member_fsync                         context.member identifies each of five members
before_staging_directory_fsync
after_staging_directory_fsync
before_staged_readback
during_staged_readback                     context.member identifies the member
after_staged_validation
before_lock_acquisition
after_lock_acquisition
before_rename
after_rename
before_parent_directory_fsync
after_parent_directory_fsync_before_response
during_staging_cleanup
during_abort_cleanup
```

Tests inject once at every required boundary and assert that `inspect`/`readCommitted` observes either absence or one complete validated package, never partial committed content.

## Slice 3A offline recovered-package migration

`migrateRecoveredReceiptPackagesV1()` and its CLI convert already-recovered local canonical candidates into packages without acquisition or production publication:

```text
node engine/src/receipt-package/migrate-recovered-packages.mjs \
  --candidates <local-recovery-candidate.json> [--candidates <file> ...] \
  --archive-root <explicit-receipt-archive-v1-root> \
  --economics-root <explicit-receipt-economics-v1-root>

node engine/src/receipt-package/migrate-recovered-packages.mjs \
  --candidates <file> [--candidates <file> ...] \
  --archive-root <path> --economics-root <path> \
  --write --package-root <explicit-pre-existing-isolated-root>
```

Dry-run is the default. Archive and economics roots are always mandatory. Write mode additionally requires a pre-existing package root; no `engine/data` or production package root is inferred. Candidate descriptors passed to the API may include `expectedSha256`, in which case the exact file bytes are checked before parsing.

For every unique receipt hash, the migration validates the complete candidate and persisted verifier result, reruns deterministic `verifyReceipt()`, requires exact published-hash reproduction and zero violations, reads compatibility records only through `readReceiptArchiveBundle()` and `readReceiptEconomics()`, compares all overlapping fields, and constructs package-native projections only through `buildReceiptPackageV1()`. Publication uses only `createReceiptPackageFsStore()` stage, staged readback validation, and commit operations. `commit_unknown` is reconciled by store inspection.

The deterministic report contains candidate/eligibility/rejection/write/unchanged/conflict counters, sorted receipt hashes, package digests, all five member hashes, and sorted error codes by candidate identity. Candidate rejection or a conflict found during preflight prevents every planned write. Before the first commit, all would-write packages are staged and read back; a staging/validation failure aborts every still-owned stage and publishes nothing.

The Slice 2 store provides an atomic visibility boundary per receipt, not a multi-receipt transaction. If a race, held per-receipt lock, durability failure, or other publication error occurs after an earlier receipt committed, already committed receipt directories remain immutable and complete; they are never rolled back. The migration aborts every still-owned current/later stage and returns the exact `committed`/`unchanged` counters plus a deterministic error code for reconciliation. Thus the root can contain a committed prefix of the hash-sorted batch, but never a partially visible receipt package. Rerun the identical reviewed batch after resolving the error: validated matching packages become `unchanged`, and absent packages are safely staged again.

The existing Slice 2 failure-evidence rule still applies: if `store.stage()` itself fails after creating its hidden staging directory, it returns no opaque handle and may retain that one hidden partial stage for administrative evidence (`.<receipt-hash>.<uuid>.tmp`). The migration must not guess its path or recursively delete it without the store capability; committed readers never expose it. Cleanup remains deferred to the separately reviewed stale-stage procedure described in the Slice 2 boundary. The golden success criterion is stricter: after successful publication both reviewed roots contain zero hidden stages or locks.

Recovery method, candidate digest, candidate/archive/economics paths, provider provenance, raw history, wallet-wide input digests, operational timestamps, upload, mint, and signing data never enter package members. Archive/economics compatibility roots are read-only and their files and indexes are not rebuilt or changed.

### Golden identities

The focused golden suite pins these byte identities. Any change requires an explicit package/profile-version decision:

| Receipt | `package_digest` | `manifest.json` | `canonical-receipt.json` | `verification.json` | `archive-record.json` | `economics.json` |
|---|---|---|---|---|---|---|
| JUP `5fb5732d…a0bbca` | `5b8d2241a70eb68b4bc1b43f3d471dbd677b6d89ba47dc0569f7af7d34e71278` | `2ce234ccedcb52ac555f49129de7a3b6660506b04ed452c02503ec626646f1f6` | `c636cfda958eb87341d3225d33b53b7dc9dcf157def5cc3a054eb56cd4e9eb61` | `851c283e7e321bee61a939f1b39dbfb1f09ec038cdd078ceca50c8f7167c6ad0` | `d28c5a58b920f526c5ed9e08e4e5b034d99285cd7182a1374f1eb9c10697c6ac` | `d8d716459707f3b8c7f95b2f6e64a3c1f1faf91e62629e0477213e4b4ed9ffbd` |
| RAY `4d33969c…0e4341` | `25e6820d0ac45e8347375eadd824fde2c6ec528b56b637a0144c013da33d5fa2` | `9fffd0746b49b5e3b89dbf113675c76290c7ae10f99542a23b1c385e3c75b41e` | `94717ca77018826e88bf39313c7b4b810ade1d42ed9f507809c649f1f6f3f2cb` | `808c2d03cd54bb13ed418ea034075dc8b523cb01e6a9ce3359d2959498141e6d` | `777987cf14a3e41034923a6acc0e87ce15ec7affef68b0e3fb32890ad24bd695` | `4664d29a151bba54051c4a8ef6044990a2ca474a4b45a421536106e9fa5d0ea8` |

### Proposed Slice 3B authoritative-root procedure

Slice 3B must be a separately authorized controlled migration. Before any write: require reviewed committed migration code and a clean/up-to-date source gate; provision and name the exact dedicated package root; hash the complete archive/economics stores; verify the exact two candidate-file digests and receipt-hash set; run a dry-run requiring `discovered=2`, `eligible=2`, `rejected=0`, `would_write=2`, and zero conflicts. Then write once through this migration API, require `committed=2`, read both packages through the store and compare every byte/digest to the golden table, rerun identically and require `unchanged=2`, inspect the root for exactly two non-hidden committed directories, repeat the privacy scan, and prove archive/economics and tracked repository bytes unchanged. Stop on any malformed existing destination, conflict, `commit_unknown` that cannot be reconciled, source-gate mismatch, or counter/digest drift. No copy, overwrite, archive/index rebuild, inventory/public-demo integration, network, upload, mint, or signing step belongs in Slice 3B.

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

## Proposed Slice 3 JUP/RAY golden-package migration

Slice 3 should migrate the two reviewed golden receipts without adding acquisition or orchestration:

1. Pin the exact reviewed JUP and RAY canonical receipt, verification, archive, economics, and input-commitment source values already present in repository fixtures/evidence. Do not fetch Helius or read mutable production inventory.
2. In an isolated new temporary root, build each package through `buildReceiptPackageV1()` and validate it through `validateReceiptPackageV1()`.
3. Serialize through `serializeReceiptPackageV1()` and record the five member SHA-256 values plus `package_digest` in a review report. Confirm JUP and RAY receipt hashes match the intended historical identities.
4. Stage, validateStage, and commit each package through this adapter. After each commit, call `inspect()` and `readCommitted()` and require exact package digest and byte equality with the in-memory serializer output.
5. Repeat publication into a second fresh temporary root and require byte-identical member files and identical package digests. Repeat publication in the first root and require `unchanged`.
6. Exercise an intentional same-receipt/different-package fixture and require `package_store_conflict` without changing either golden directory.
7. Review the resulting temporary tree and checksums. Keep package UUIDs/paths out of golden data; retain only the five canonical member files per receipt.
8. Only after explicit approval of the exact target root, copy/publish via stage/commit into a dedicated receipt-package root. Do not write archive/economics indexes, inventory, public-demo output, upload state, mint state, or signing state.
9. Reconcile any `commit_unknown` with `inspect()` before deciding whether to retry. Never overwrite a malformed or conflicting historical directory.
10. Run Slice 1, store, v1.9, v1.10, and v1.11 deterministic regressions and compare the target root before/after inventory separately. Git staging/commit/push remains under user control.

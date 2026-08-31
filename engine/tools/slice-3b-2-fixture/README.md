# Slice 3B-2 local compatibility fixture tooling

This directory prepares the two-control mainnet owner-enumeration fixture. Run secret-bearing commands only on the trusted local workstation. Do not run `generate-controls.mjs` or an execution command on the Artifact VPS.

## Files

- `fixture-core.mjs` — pure constants, address derivation, exact two-instruction plan, cost/layout gates, and frozen public-manifest construction.
- `generate-controls.mjs` — local-only, exclusive mode-`0600` keypair generation. It emits only public addresses.
- `prepare-or-execute-setup.mjs` — pure/default-safe orchestration and read-only preflight collection.
- `local-fixture-cli.mjs` — local CLI. It fixes independent verification to `https://api.mainnet-beta.solana.com`; default/unknown modes refuse execution.
- `fixture-tooling.test.mjs` — offline tests using synthetic keys and fake RPC evidence only.

No tooling in this directory calls an owner-enumeration method to build the expected manifest.

## Fixed identities

Classic:

- mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- program: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`

Token-2022:

- mint: `9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP`
- program: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`

Associated-token program:

- `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`

The read-only preflight independently fetches both mint accounts from the fixed non-Helius mainnet RPC, requires exact outer program ownership, and decodes each mint with the matching SPL Token program. It computes the associated-account length, including the Token-2022 ATA program’s mandatory `ImmutableOwner` account extension, before any destination-account, rent, blockhash, fee, simulation, signer, or submission capability is used.

**Narrow approved layout contract:** the classic USDC ATA is exactly 165 bytes. The fixed `NATIVE_MINT_2022` ATA is exactly 170 bytes and contains exactly the associated-token program’s required `ImmutableOwner` extension. This is not arbitrary Token-2022 account-layout support. Any different length, additional extension, selected mint, or token program is a STOP before destination lookup, rent, fee, simulation, signer access, or submission.

## 1. Verify tooling locally

From a trusted local checkout with the repository's Node dependencies installed:

```sh
node --test engine/tools/slice-3b-2-fixture/fixture-tooling.test.mjs
node --check engine/tools/slice-3b-2-fixture/fixture-core.mjs
node --check engine/tools/slice-3b-2-fixture/generate-controls.mjs
node --check engine/tools/slice-3b-2-fixture/prepare-or-execute-setup.mjs
node --check engine/tools/slice-3b-2-fixture/local-fixture-cli.mjs
```

## 2. Generate controls locally

Choose absolute, canonical paths outside every Git checkout. The secret directory must not already exist; every output is exclusive-create. The generator fails closed unless the exact local-machine attestation is supplied, rejects any path under a Git worktree, and rejects symlink/noncanonical parents. This attestation is an operator assertion, not automatic proof of host trust: do not provide it on the Artifact VPS.

```sh
umask 077
export SLICE_3B2_LOCAL_ROOT="$HOME/.local/share/artifact-slice-3b-2"
export SLICE_3B2_SECRET_DIR="$SLICE_3B2_LOCAL_ROOT/control-keypairs"
export SLICE_3B2_PUBLIC_CONTROLS="$SLICE_3B2_LOCAL_ROOT/controls-public.json"
mkdir -p -m 700 "$SLICE_3B2_LOCAL_ROOT"

node engine/tools/slice-3b-2-fixture/generate-controls.mjs \
  --generate-local-controls \
  --secret-dir "$SLICE_3B2_SECRET_DIR" \
  --public-output "$SLICE_3B2_PUBLIC_CONTROLS" \
  --local-machine-attestation I_CONFIRM_THIS_IS_A_TRUSTED_LOCAL_MACHINE_NOT_THE_ARTIFACT_VPS
```

Generated secret files:

- `$SLICE_3B2_SECRET_DIR/empty-control.keypair.json`
- `$SLICE_3B2_SECRET_DIR/known-control.keypair.json`

Do not print, copy, hash, upload, or commit those files. The known-control private key is not needed by setup and must not sign. Only `controls-public.json` may leave the workstation.

## 3. Build the provider-free offline plan

Set the existing local funding wallet's public key only. This command makes no network or signer call.

```sh
export SLICE_3B2_FEE_PAYER_PUBLIC_KEY='<LOCAL FUNDING WALLET PUBLIC KEY>'
export SLICE_3B2_OFFLINE_PLAN="$SLICE_3B2_LOCAL_ROOT/offline-plan.json"

node engine/tools/slice-3b-2-fixture/local-fixture-cli.mjs \
  --offline-plan \
  --controls-public "$SLICE_3B2_PUBLIC_CONTROLS" \
  --fee-payer-pubkey "$SLICE_3B2_FEE_PAYER_PUBLIC_KEY" \
  --output "$SLICE_3B2_OFFLINE_PLAN"
```

The output contains the two public control addresses, both derived token-account addresses, and the exact instruction descriptors. It contains no private material.

## 4. Separately authorize and run the read-only mainnet preflight

Do not run this step until provider calls are approved. It uses only the fixed independent standard RPC and does not load a signer.

```sh
export SLICE_3B2_PREFLIGHT="$SLICE_3B2_LOCAL_ROOT/read-only-preflight.json"

node engine/tools/slice-3b-2-fixture/local-fixture-cli.mjs \
  --read-only-mainnet-preflight \
  --controls-public "$SLICE_3B2_PUBLIC_CONTROLS" \
  --fee-payer-pubkey "$SLICE_3B2_FEE_PAYER_PUBLIC_KEY" \
  --output "$SLICE_3B2_PREFLIGHT"
```

The preflight performs, in order:

1. mainnet genesis-hash verification;
2. one finalized exact-key fetch for the two mint accounts;
3. exact selected-mint, outer-program, mint-layout, and ATA-layout verification;
4. exact acceptance of classic 165 bytes and Token-2022 170 bytes with required `ImmutableOwner`;
5. STOP on every other Token-2022 extension/layout;
6. destination-account absence checks;
7. independent current rent lookups for exactly 165 and 170 bytes;
8. current fee lookup for the exact compiled message;
9. STOP if rent plus fee exceeds the unchanged `6,000,000`-lamport (`0.006 SOL`) cap;
10. simulation of the exact two-instruction transaction.

No signer material or submission capability is used by this mode.

## 5. Exact transaction shape

The approved outer shape remains one legacy transaction, one signer (the existing local fee payer), and exactly two instructions:

1. Create the classic USDC ATA for the known-control owner.
2. Create the Token-2022 native-mint ATA for the known-control owner.

Neither control wallet receives SOL or signs. There is no mint creation, `mintTo`, token transfer, SOL transfer to a control, `syncNative`, approve/delegate, authority change, close, memo, or unrelated instruction.

## 6. Gated execution interface

This amendment approves only tooling readiness. Do not run the command below without separate explicit authorization for local control generation, signer loading, spending, and the one mainnet setup transaction.

The funding keypair path stays local, must be absolute and canonical, must be outside every Git worktree, and must have no group/other permission bits. The exact local-machine attestation is mandatory. Neither the manifest path nor the derived `<manifest-path>.submission-intent.json` sidecar path may already exist.

```sh
export SLICE_3B2_FUNDING_KEYPAIR='<ABSOLUTE LOCAL PATH TO EXISTING FUNDING KEYPAIR>'
export SLICE_3B2_PUBLIC_MANIFEST="$SLICE_3B2_LOCAL_ROOT/frozen-public-manifest.json"

node engine/tools/slice-3b-2-fixture/local-fixture-cli.mjs \
  --execute-authorized-mainnet-setup \
  --authorization SLICE_3B_2_ONE_MAINNET_SETUP_TRANSACTION_APPROVED \
  --controls-public "$SLICE_3B2_PUBLIC_CONTROLS" \
  --fee-payer-pubkey "$SLICE_3B2_FEE_PAYER_PUBLIC_KEY" \
  --funding-keypair "$SLICE_3B2_FUNDING_KEYPAIR" \
  --local-machine-attestation I_CONFIRM_THIS_IS_A_TRUSTED_LOCAL_MACHINE_NOT_THE_ARTIFACT_VPS \
  --manifest-output "$SLICE_3B2_PUBLIC_MANIFEST"
```

Execution repeats the complete read-only preflight immediately before loading the funding keypair. It signs once and synchronously writes a separate public submission-intent sidecar at `<manifest-path>.submission-intent.json`, containing the locally derived signature and message hash, before any submission attempt. It then submits one raw transaction with `maxRetries: 0`, requires the returned signature to match the locally signed transaction, waits for finalized confirmation, and requires finalized `getTransaction` evidence to contain that exact signature and byte-identical serialized message. It retrieves both exact accounts and validates outer owner, mint, authority, raw-zero state, exact 165-byte classic non-native layout, and exact 170-byte Token-2022 native layout with exactly `ImmutableOwner` before writing the frozen public manifest. The sidecar is retained even after success, so a manifest-write failure cannot destroy the recovery signature.

If submission throws or finalization becomes ambiguous, the synchronized public submission-intent sidecar remains. Do not rerun. Use its `signature`, message hash, blockhash window, and exact account addresses for targeted reconciliation first.

## 7. Frozen public manifest (future, after separately authorized execution)

If the exact 165/170 preflight contract passes and a separately authorized setup finalizes, the manifest contains only public evidence:

```json
{
  "fixture_version": "artifact_slice_3b_2_owner_enumeration_fixture_v1",
  "network": "mainnet-beta",
  "genesis_hash": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "created_at_utc": "<RFC3339>",
  "empty_control": {
    "wallet": "<PUBLIC KEY>",
    "setup_actions": [],
    "controlled_condition": "locally_generated_never_funded_never_used"
  },
  "known_control": {
    "wallet": "<PUBLIC KEY>",
    "setup_transaction": {
      "signature": "<PUBLIC SIGNATURE>",
      "finalized_slot": 0,
      "fee_payer": "<PUBLIC KEY>",
      "sanitized_transaction_sha256": "<MESSAGE SHA-256>"
    },
    "expected_accounts": {
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": ["<FULL PUBLIC ROW>"],
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": ["<FULL PUBLIC ROW>"]
    }
  },
  "evidence_boundary": {
    "population_basis": "fresh_control_plus_exact_locally_constructed_finalized_setup",
    "known_row_confirmation": ["finalized_getTransaction", "finalized_getMultipleAccounts"],
    "owner_enumeration_used_to_build_expected_sets": false,
    "ata_derivation_used_as_completeness_proof": false
  },
  "manifest_sha256": "<CANONICAL PREIMAGE SHA-256>"
}
```

Each full account row retains account public key, mint, token program, creation instruction index, creation transaction signature, finalized slot, ordered instruction accounts, outer owner program, exact lane-specific account length (`165` classic, `170` Token-2022), native-state boolean, raw account-data SHA-256, raw amount `"0"`, and `decimals: null`. Final Token-2022 validation additionally requires exactly the `ImmutableOwner` extension.

Deterministic ATA derivation identifies the intended instruction accounts but is not treated as proof of owner-population completeness.

## 8. VPS boundary and later Helius probe

Only after the transaction is finalized and the public manifest is frozen:

1. Copy `controls-public.json` and `frozen-public-manifest.json` to the VPS; never copy either keypair or the funding keypair.
2. Verify `manifest_sha256` before extracting public inputs.
3. Populate the existing compatibility probe's empty wallet, known wallet, classic expected-account array, and Token-2022 expected-account array from the manifest.
4. Reserve a unique report path and run the already-built Helius compatibility probe once under its separate live authorization.
5. Interpret equal slots as the same finalized Helius indexed state, not proof of one exact Agave bank snapshot.

## 9. Decimals boundary

Fixture rows use exact raw amount `"0"` and `decimals: null`. The separate narrow 3B carrier patch must require null decimals unless independently bound mint evidence is introduced in a future version. This tooling does not add mint metadata, unit normalization, or accounting behavior.

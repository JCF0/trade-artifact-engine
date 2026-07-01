import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

export function createInventoryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'trade-artifact-inventory-'));
  const debugDir = join(root, 'data', 'debug');
  const receiptsDir = join(root, 'data', 'receipts');
  const testDir = join(root, 'data', '_test');
  const e2eDir = join(root, 'data', '_e2e_test', 'receipts');
  const backupDir = join(root, 'data', 'backup');

  mkdirSync(debugDir, { recursive: true });
  mkdirSync(receiptsDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  mkdirSync(e2eDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  const receiptAHash = 'a'.repeat(64);
  const receiptBHash = 'b'.repeat(64);
  const candidateAHash = 'c'.repeat(64);
  const candidateBHash = 'd'.repeat(64);
  const legacyHash = 'e'.repeat(64);
  const excludedHash1 = 'f'.repeat(64);
  const excludedHash2 = '1'.repeat(64);
  const excludedHash3 = '2'.repeat(64);

  writeJson(join(debugDir, 'ledger-receipts-v12.json'), [
    {
      receipt_id: 'art_v12_cp_TEST_0',
      receipt_version: '1.2.0',
      receipt_type: 'closed_position',
      token_mint: 'TEST_TOKEN_A',
      wallet: 'TEST_WALLET',
      chain: 'solana',
      segment_index: 0,
      receipt_hash: receiptAHash,
      verification_status: 'verified',
      display_status: 'Verified Closed Position',
      accounting_method: 'weighted_average_position_accounting_v1',
      quote_mint: 'So11111111111111111111111111111111111111112',
      quote_symbol: 'SOL',
      valuation_status: 'raw_quote',
      position_status: 'closed',
      first_event_at: 1700000000,
      last_event_at: 1700000300,
      snapshot_at: null,
      limitations: {
        receipt_scope: 'closed_position',
        valuation_currency: 'raw_quote',
        disclosures: ['no_usd_normalization'],
      },
      flags: [],
      candidate_hash: candidateAHash,
    },
    {
      receipt_id: 'art_v12_os_TEST_1',
      receipt_version: '1.2.0',
      receipt_type: 'open_snapshot',
      token_mint: 'TEST_TOKEN_B',
      wallet: 'TEST_WALLET',
      chain: 'solana',
      segment_index: 1,
      receipt_hash: receiptBHash,
      verification_status: 'verified_snapshot',
      display_status: 'Verified Snapshot (No PnL Claim)',
      accounting_method: 'weighted_average_position_accounting_v1',
      quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      quote_symbol: 'USDC',
      valuation_status: 'raw_quote',
      position_status: 'open',
      first_event_at: 1700000400,
      last_event_at: 1700000800,
      snapshot_at: 1700000900,
      limitations: {
        receipt_scope: 'open_snapshot',
        valuation_currency: 'raw_quote',
        disclosures: ['no_pnl_claim'],
      },
      flags: ['unsupported_inventory'],
      candidate_hash: candidateBHash,
    },
  ]);

  writeJson(join(debugDir, 'ledger-verify-v12.json'), {
    total: 2,
    passed: 2,
    failed: 0,
    results: [
      {
        receipt_id: 'art_v12_cp_TEST_0',
        receipt_hash: receiptAHash,
        recomputed_hash: receiptAHash,
        hash_valid: true,
        rule_violations: [],
        schema_valid: true,
        consistency_valid: true,
        pass: true,
      },
      {
        receipt_id: 'art_v12_os_TEST_1',
        receipt_hash: receiptBHash,
        recomputed_hash: receiptBHash,
        hash_valid: true,
        rule_violations: [],
        schema_valid: true,
        consistency_valid: true,
        pass: true,
      },
    ],
  });

  writeJson(join(debugDir, 'ledger-valuations-v12.json'), {
    generated_at: '2026-07-01T00:00:00.000Z',
    receipt_count: 2,
    all_valid: true,
    contexts: [
      {
        receipt_id: 'art_v12_cp_TEST_0',
        valuation_status: 'raw_quote',
        valuation_currency: 'raw_quote',
        quote_is_usd_stable: false,
        valid: true,
        violations: [],
      },
      {
        receipt_id: 'art_v12_os_TEST_1',
        valuation_status: 'raw_quote',
        valuation_currency: 'raw_quote',
        quote_is_usd_stable: true,
        valid: true,
        violations: [],
      },
    ],
  });

  writeJson(join(debugDir, 'ledger-image-artifacts-v12.json'), {
    generated_at: '2026-07-01T00:00:00.000Z',
    artifact_type: 'svg',
    artifacts: [
      {
        receipt_id: 'art_v12_cp_TEST_0',
        render_status: 'rendered',
        local_path: 'data/debug/receipt-images-v12/art_v12_cp_TEST_0.svg',
        artifact_hash: 'sha256:img-a',
      },
      {
        receipt_id: 'art_v12_os_TEST_1',
        render_status: 'rendered',
        local_path: 'data/debug/receipt-images-v12/art_v12_os_TEST_1.svg',
        artifact_hash: 'sha256:img-b',
      },
    ],
  });

  writeJson(join(debugDir, 'ledger-metadata-v12.json'), {
    generated_at: '2026-07-01T00:00:00.000Z',
    metadata: [
      {
        name: 'Trade Receipt #art_v12_cp_TEST_0',
        external_url: null,
        properties: {
          receipt_id: 'art_v12_cp_TEST_0',
          receipt_hash: receiptAHash,
          candidate_hash: candidateAHash,
        },
      },
      {
        name: 'Trade Receipt #art_v12_os_TEST_1',
        external_url: null,
        properties: {
          receipt_id: 'art_v12_os_TEST_1',
          receipt_hash: receiptBHash,
          candidate_hash: candidateBHash,
        },
      },
    ],
  });

  writeJson(join(debugDir, 'ledger-upload-dry-run-v12.json'), {
    generated_at: '2026-07-01T00:00:00.000Z',
    entries: [
      {
        receipt_id: 'art_v12_cp_TEST_0',
        receipt_hash: receiptAHash,
        image_artifact_path: 'data/debug/receipt-images-v12/art_v12_cp_TEST_0.svg',
        metadata_template_path: 'data/debug/metadata-packages-v12/art_v12_cp_TEST_0.metadata.template.json',
        resolved_metadata_path: 'data/debug/upload-dry-run-v12/art_v12_cp_TEST_0.metadata.resolved.dryrun.json',
        upload_mode: 'dry_run',
        upload_status: 'simulated_not_uploaded',
      },
      {
        receipt_id: 'art_v12_os_TEST_1',
        receipt_hash: receiptBHash,
        image_artifact_path: 'data/debug/receipt-images-v12/art_v12_os_TEST_1.svg',
        metadata_template_path: 'data/debug/metadata-packages-v12/art_v12_os_TEST_1.metadata.template.json',
        resolved_metadata_path: 'data/debug/upload-dry-run-v12/art_v12_os_TEST_1.metadata.resolved.dryrun.json',
        upload_mode: 'dry_run',
        upload_status: 'simulated_not_uploaded',
      },
    ],
  });

  writeJson(join(debugDir, 'ledger-upload-results-v12.json'), {
    generated_at: '2026-07-01T00:00:00.000Z',
    results: [
      {
        receipt_id: 'art_v12_cp_TEST_0',
        receipt_hash: receiptAHash,
        source_image_artifact_hash: 'sha256:img-a',
        source_metadata_template_path: 'data/debug/metadata-packages-v12/art_v12_cp_TEST_0.metadata.template.json',
        final_metadata_path: 'data/debug/upload-results-v12/art_v12_cp_TEST_0.metadata.final.json',
        final_image_uri: 'https://example.invalid/image-a',
        final_metadata_uri: 'https://example.invalid/meta-a',
        upload_mode: 'live',
        upload_status: 'complete',
        network: 'devnet',
        uploaded_at: '2026-07-01T00:01:00.000Z',
        uploader_pubkey: 'UPLOADER_A',
      },
    ],
  });

  writeJson(join(debugDir, 'ledger-mint-plan-v12.json'), {
    generated_at: '2026-07-01T00:00:00.000Z',
    plans: [
      {
        receipt_id: 'art_v12_cp_TEST_0',
        receipt_hash: receiptAHash,
        receipt_type: 'closed_position',
        verification_status: 'verified',
        network: 'devnet',
        metadata_uri: null,
        image_uri: null,
        external_url: null,
        proof_wallet_pubkey: null,
        mint_authority_pubkey: null,
        mint_ready: false,
        mint_blockers: ['explicit_mint_approval_required'],
        required_before_mint: [{ step: 'explicit_approval', status: 'not_started' }],
      },
      {
        receipt_id: 'art_v12_os_TEST_1',
        receipt_hash: receiptBHash,
        receipt_type: 'open_snapshot',
        verification_status: 'verified_snapshot',
        network: 'devnet',
        metadata_uri: null,
        image_uri: null,
        external_url: null,
        proof_wallet_pubkey: null,
        mint_authority_pubkey: null,
        mint_ready: false,
        mint_blockers: ['metadata_uri_missing'],
        required_before_mint: [{ step: 'upload_metadata', status: 'not_started' }],
      },
    ],
  });

  writeJson(join(debugDir, 'ledger-mint-results-v12.json'), {
    generated_at: '2026-07-01T00:00:00.000Z',
    results: [
      {
        receipt_id: 'art_v12_cp_TEST_0',
        receipt_hash: receiptAHash,
        metadata_uri: 'https://example.invalid/meta-a',
        image_uri: 'https://example.invalid/image-a',
        mint_address: 'MINT_A',
        token_account: 'TOKEN_ACCOUNT_A',
        proof_wallet_pubkey: 'PROOF_WALLET_A',
        mint_authority_pubkey: 'MINT_AUTH_A',
        transaction_signature: 'TX_A',
        network: 'devnet',
        mint_status: 'minted',
        minted_at: '2026-07-01T00:02:00.000Z',
      },
    ],
  });

  writeJson(join(debugDir, 'v12-proof-pipeline-summary.json'), {
    schema: 'v12_proof_pipeline_summary',
    version: '1.0.0',
    receipts: [
      {
        receipt_id: 'art_v12_cp_TEST_0',
        receipt_type: 'closed_position',
        token_mint: 'TEST_TOKEN_A',
        verification_status: 'verified',
        receipt_hash: receiptAHash,
        candidate_hash: candidateAHash,
        hash_valid: true,
        violations: 0,
      },
      {
        receipt_id: 'art_v12_os_TEST_1',
        receipt_type: 'open_snapshot',
        token_mint: 'TEST_TOKEN_B',
        verification_status: 'verified_snapshot',
        receipt_hash: receiptBHash,
        candidate_hash: candidateBHash,
        hash_valid: true,
        violations: 0,
      },
    ],
  });

  writeJsonl(join(receiptsDir, 'receipts.jsonl'), [
    {
      receipt_id: 'legacy_prod_1',
      receipt_type: 'verified',
      wallet: 'LEGACY_WALLET',
      chain: 'solana',
      token_mint: 'LEGACY_TOKEN',
      verification_hash: legacyHash,
    },
  ]);

  writeJsonl(join(testDir, 'receipts.jsonl'), [
    {
      receipt_id: 'legacy_test_1',
      verification_hash: excludedHash1,
    },
  ]);

  writeJsonl(join(e2eDir, 'receipts.jsonl'), [
    {
      receipt_id: 'legacy_e2e_1',
      verification_hash: excludedHash2,
    },
  ]);

  writeJsonl(join(backupDir, 'receipts.jsonl'), [
    {
      receipt_id: 'legacy_backup_1',
      verification_hash: excludedHash3,
    },
  ]);

  return {
    root,
    hashes: {
      receiptAHash,
      receiptBHash,
      legacyHash,
      excludedHash1,
      excludedHash2,
      excludedHash3,
    },
  };
}

export function removeInventoryFixture(root) {
  rmSync(root, { recursive: true, force: true });
}

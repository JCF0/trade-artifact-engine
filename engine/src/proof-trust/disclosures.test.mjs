import assert from 'assert';

import {
  DISCLOSURE_TEXT,
  buildDisclosureSet,
  getCoreDisclosures,
  getCorrelatableDisclosure,
  getHostedSemanticsDisclosure,
} from './disclosures.mjs';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

test('core disclosures include selected-receipt, raw-quote, and wallet-display notices', () => {
  assert.deepEqual(getCoreDisclosures(), [
    DISCLOSURE_TEXT.selectedReceiptOnly,
    DISCLOSURE_TEXT.rawQuoteOnly,
    DISCLOSURE_TEXT.walletDisplayPublisherControlled,
  ]);
});

test('hosted semantics disclosure is stable', () => {
  assert.equal(
    getHostedSemanticsDisclosure(),
    'Hosted, unlisted, and private labels describe display or distribution choices only. They do not increase proof strength.',
  );
});

test('correlatable disclosure is stable', () => {
  assert.equal(
    getCorrelatableDisclosure(),
    'Source anchors make this proof correlatable and should not be treated as private.',
  );
});

test('buildDisclosureSet adds optional disclosures additively', () => {
  const disclosures = buildDisclosureSet({
    includeHostedSemantics: true,
    includeCorrelatableDisclosure: true,
  });

  assert.deepEqual(disclosures, [
    DISCLOSURE_TEXT.selectedReceiptOnly,
    DISCLOSURE_TEXT.rawQuoteOnly,
    DISCLOSURE_TEXT.walletDisplayPublisherControlled,
    DISCLOSURE_TEXT.hostedVisibilitySemantics,
    DISCLOSURE_TEXT.correlatableAnchors,
  ]);
});

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

export const DISCLOSURE_TEXT = {
  selectedReceiptOnly: 'Selected receipt only. Not a portfolio statement.',
  rawQuoteOnly: 'Raw quote only. No USD normalization.',
  walletDisplayPublisherControlled: 'Wallet display may be truncated or redacted by publisher.',
  hostedVisibilitySemantics: 'Hosted, unlisted, and private labels describe display or distribution choices only. They do not increase proof strength.',
  correlatableAnchors: 'Source anchors make this proof correlatable and should not be treated as private.',
};

export function getCoreDisclosures() {
  return [
    DISCLOSURE_TEXT.selectedReceiptOnly,
    DISCLOSURE_TEXT.rawQuoteOnly,
    DISCLOSURE_TEXT.walletDisplayPublisherControlled,
  ];
}

export function getHostedSemanticsDisclosure() {
  return DISCLOSURE_TEXT.hostedVisibilitySemantics;
}

export function getCorrelatableDisclosure() {
  return DISCLOSURE_TEXT.correlatableAnchors;
}

export function buildDisclosureSet(options = {}) {
  const includeHostedSemantics = options.includeHostedSemantics === true;
  const includeCorrelatableDisclosure = options.includeCorrelatableDisclosure === true;

  const disclosures = [...getCoreDisclosures()];

  if (includeHostedSemantics) {
    disclosures.push(getHostedSemanticsDisclosure());
  }

  if (includeCorrelatableDisclosure) {
    disclosures.push(getCorrelatableDisclosure());
  }

  return disclosures;
}

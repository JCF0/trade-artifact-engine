// Local-only transfer of an explicitly supplied qualification fixture input.
import { readFileSync } from 'node:fs';
import { put } from './bounded-successor.mjs';
const fixture = JSON.parse(readFileSync('/fixture-case.json'));
if (fixture.classification !== 'SYNTHETIC_ONLY_NOT_PROVIDER') throw Error('FIXTURE_STOP');
const input = JSON.parse(readFileSync('/qualification-input-v1.json', 'utf8'));
put('/evidence', 'synthetic-public-input.json', input);
put('/evidence', 'fixture-classification.json', { classification: 'SYNTHETIC_ONLY_NOT_PROVIDER',
  case: fixture.case, public_input: 'RECOVERED_PROVENANCE_OR_EXPLICIT_NEGATIVE_MUTATION',
  route_origin: 'retained calibration bytes used only as a synthetic provider fixture',
  fee_and_quote: 'synthetic fee corroboration and locally calculated quote, not current observations' });

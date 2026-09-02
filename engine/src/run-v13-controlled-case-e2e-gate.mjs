#!/usr/bin/env node
import { canonicalJson } from './verification-scope-v1-3/contract.mjs';
import {
  controlledCaseGateExitCodeV1,
  runControlledCaseOfflineE2EGateV1,
} from './verification-scope-v1-3/controlled-case-e2e-gate-v1.mjs';

const result = await runControlledCaseOfflineE2EGateV1();
process.stdout.write(canonicalJson(result));
process.exitCode = controlledCaseGateExitCodeV1(result);

import { types as utilTypes } from 'node:util';

import {
  detachProviderNeutralValueV1,
  failWalletAcquisitionOperationV1,
  sanitizeWalletAcquisitionErrorV1,
} from './provider-port.mjs';

export const WALLET_ACQUISITION_PORT_METHODS_V2 = Object.freeze([
  'getNetworkIdentityV1',
  'getFinalizedSlotV1',
  'getFinalizedBlockV1',
  'getFinalizedWalletSignaturePageV1',
  'getFinalizedFullTransactionPageV1',
  'getFinalizedTransactionV1',
]);

const ACQUISITION_STARTERS_V2 = new WeakMap();

function validateCapability(capability) {
  try {
    if (capability === null || typeof capability !== 'object' || Array.isArray(capability)
        || utilTypes.isProxy(capability) || Object.getPrototypeOf(capability) !== Object.prototype
        || Object.getOwnPropertySymbols(capability).length !== 0) {
      failWalletAcquisitionOperationV1('acquisition_capability_denied');
    }
    const descriptors = Object.getOwnPropertyDescriptors(capability);
    if (Object.keys(descriptors).length !== WALLET_ACQUISITION_PORT_METHODS_V2.length) {
      failWalletAcquisitionOperationV1('acquisition_capability_denied');
    }
    return Object.fromEntries(WALLET_ACQUISITION_PORT_METHODS_V2.map(name => {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
          || typeof descriptor.value !== 'function') {
        failWalletAcquisitionOperationV1('acquisition_capability_denied');
      }
      return [name, descriptor.value.bind(capability)];
    }));
  } catch (error) {
    throw sanitizeWalletAcquisitionErrorV1(error, 'acquisition_capability_denied');
  }
}

function validateOptions(options, capability) {
  if (options === undefined) return ACQUISITION_STARTERS_V2.get(capability) ?? null;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)
        || utilTypes.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype
        || Object.getOwnPropertySymbols(options).length !== 0) {
      failWalletAcquisitionOperationV1('acquisition_capability_denied');
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    if (Object.keys(descriptors).length !== 1 || !descriptors.beginAcquisitionV2?.enumerable
        || !Object.hasOwn(descriptors.beginAcquisitionV2, 'value')
        || typeof descriptors.beginAcquisitionV2.value !== 'function') {
      failWalletAcquisitionOperationV1('acquisition_capability_denied');
    }
    return descriptors.beginAcquisitionV2.value;
  } catch (error) {
    throw sanitizeWalletAcquisitionErrorV1(error, 'acquisition_capability_denied');
  }
}

export function createWalletHistoryPortV2(capability, options) {
  const methods = validateCapability(capability);
  const starter = validateOptions(options, capability);
  const port = {};
  for (const name of WALLET_ACQUISITION_PORT_METHODS_V2) {
    Object.defineProperty(port, name, {
      enumerable: true,
      value: async (...args) => {
        try {
          return detachProviderNeutralValueV1(await methods[name](...args));
        } catch (error) {
          throw sanitizeWalletAcquisitionErrorV1(error);
        }
      },
    });
  }
  Object.freeze(port);
  if (starter !== null) ACQUISITION_STARTERS_V2.set(port, starter);
  return port;
}

export function beginWalletHistoryAcquisitionV2(port, budgets) {
  const starter = port !== null && typeof port === 'object' ? ACQUISITION_STARTERS_V2.get(port) : null;
  if (starter === null || starter === undefined) failWalletAcquisitionOperationV1('acquisition_capability_denied');
  try {
    starter(detachProviderNeutralValueV1(budgets));
    return true;
  } catch (error) {
    throw sanitizeWalletAcquisitionErrorV1(error, 'acquisition_capability_denied');
  }
}

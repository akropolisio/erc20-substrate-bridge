import { GenericAccountId } from '@polkadot/types';

import { ToRequestConverters } from './types';

export const toRequestConverters: ToRequestConverters = {
  'query.token.balance': registry => address => new GenericAccountId(registry, address),
};

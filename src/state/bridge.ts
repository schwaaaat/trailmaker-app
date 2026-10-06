// Lane B. SessionBridge (src/ui/contract.ts) over the app store: how src/io opens, autosaves
// and restores sessions without importing store internals.
import type { SessionBridge } from '../ui/contract';
import { appStore, openSession, replaceMap } from './store';

export const sessionBridge: SessionBridge = {
  getSession: () => appStore.getState().session,
  subscribe(listener) {
    return appStore.subscribe((state, prev) => {
      if (state.session !== prev.session) listener(state.session);
    });
  },
  openSession,
  replaceMap,
};

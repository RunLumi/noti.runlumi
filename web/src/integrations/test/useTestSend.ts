import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { deliveriesApi } from '../../deliveries/api';
import { deliveryKeys } from '../../deliveries/hooks';
import { setupKeys } from '../../setup/hooks';
import { testSendApi } from './api';
import { pollTest, type TestOutcome } from './poll';

export type TestState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'sending' }
  | { readonly phase: 'waiting' }
  | { readonly phase: 'done'; readonly outcome: TestOutcome }
  | { readonly phase: 'error'; readonly error: unknown };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One integration's "send a test": create the delivery, then poll it until it has a result the
 * person can read. A second click while one is running is ignored (the button is aria-disabled
 * too); unmounting cancels the wait, so a closed panel never updates a gone component.
 */
export function useTestSend(orgId: string, integrationId: string, onSettled?: () => void) {
  const qc = useQueryClient();
  const [state, setState] = useState<TestState>({ phase: 'idle' });
  const run = useRef(0);
  const busy = useRef(false);

  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  const send = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const mine = ++run.current;
    const cancelled = () => run.current !== mine;
    setState({ phase: 'sending' });
    try {
      const deliveryId = await testSendApi.send(orgId, integrationId);
      if (cancelled()) return;
      setState({ phase: 'waiting' });
      const outcome = await pollTest({
        read: async () => (await deliveriesApi.get(orgId, deliveryId)).delivery,
        sleep,
        now: () => Date.now(),
        cancelled,
      });
      if (outcome === null || cancelled()) return;
      setState({ phase: 'done', outcome });
      void qc.invalidateQueries({ queryKey: deliveryKeys.all(orgId) });
      void qc.invalidateQueries({ queryKey: setupKeys.all(orgId) });
      onSettled?.();
    } catch (error) {
      if (!cancelled()) setState({ phase: 'error', error });
    } finally {
      busy.current = false;
    }
  }, [orgId, integrationId, qc, onSettled]);

  return { state, send };
}

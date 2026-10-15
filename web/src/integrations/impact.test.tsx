// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n/locale';
import { ApiError, parseImpact, type IntegrationImpact } from '../lib/api';
import { ImpactSummary } from './ImpactSummary';

/** The pause and delete consequence copy (ADR 0050), rendered from the counts alone. */
afterEach(cleanup);

const zero = { count: 0, capped: false };
const impact = (over: Partial<IntegrationImpact> = {}): IntegrationImpact => ({
  unsent: zero,
  sending: zero,
  total: zero,
  heldWaiting: 0,
  heldFailed: 0,
  ...over,
});

const show = (action: 'pause' | 'delete', value: IntegrationImpact) => {
  setLocale('en', { persist: false });
  render(<ImpactSummary action={action} impact={value} isPending={false} isError={false} />);
};

describe('ImpactSummary', () => {
  it('says "more than" for a count the server stopped at its cap', () => {
    show('pause', impact({ total: { count: 10_000, capped: true } }));
    expect(screen.getByText('More than 10,000 past deliveries stay in Activity.')).toBeTruthy();
  });

  it('leaves out a group with nothing in it rather than showing "0"', () => {
    show('pause', impact());
    expect(screen.getByText('No notifications are waiting to be sent.')).toBeTruthy();
    expect(screen.queryByText(/^0 /)).toBeNull();
    expect(screen.queryByText(/past deliver/)).toBeNull();
  });

  it('uses the singular for one', () => {
    show('delete', impact({ unsent: { count: 1, capped: false }, total: { count: 1, capped: false } }));
    expect(screen.getByText(/^1 notification has not been sent yet\. It will not go out/)).toBeTruthy();
    expect(screen.getByText(/^1 past delivery stays in Activity/)).toBeTruthy();
  });

  it('counts failed saved updates as removed by a delete, but not as kept by a pause', () => {
    show('delete', impact({ heldWaiting: 2, heldFailed: 1 }));
    expect(screen.getByText('3 saved updates are deleted with the integration and never sent.')).toBeTruthy();
    cleanup();
    show('pause', impact({ heldWaiting: 2, heldFailed: 1 }));
    expect(screen.getByText(/^2 updates saved for quiet hours/)).toBeTruthy();
  });

  it('says the number is unknown when the count failed, never zero', () => {
    setLocale('en', { persist: false });
    render(<ImpactSummary action="delete" impact={undefined} isPending={false} isError />);
    expect(screen.getByRole('status').textContent).toContain('couldn’t count');
    expect(screen.getByRole('status').textContent).not.toMatch(/\b0\b/);
  });
});

describe('parseImpact', () => {
  const body = {
    impact: {
      deliveries: {
        total: { count: 4, capped: false },
        unsent: { count: 1, capped: false },
        sending: { count: 0, capped: false },
      },
      held: { waiting: 2, failed: 0 },
    },
  };

  it('reads the server shape', () => {
    expect(parseImpact(body)).toEqual({
      total: { count: 4, capped: false },
      unsent: { count: 1, capped: false },
      sending: zero,
      heldWaiting: 2,
      heldFailed: 0,
    });
  });

  it('rejects a malformed answer instead of reading it as zero', () => {
    expect(() => parseImpact({})).toThrow(ApiError);
    expect(() => parseImpact({ impact: { ...body.impact, held: { waiting: '2', failed: 0 } } })).toThrow(
      ApiError,
    );
    const missing = {
      impact: { ...body.impact, deliveries: { ...body.impact.deliveries, unsent: { count: 1 } } },
    };
    expect(() => parseImpact(missing)).toThrow(ApiError);
  });
});

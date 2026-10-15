// @vitest-environment jsdom
import '../a11y/testing/environment';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMBER } from '../a11y/testing/fixtures';
import { renderApp } from '../a11y/testing/render';
import { catalogues, en } from '../i18n';
import { EmptyState, Skeleton } from './state';

/**
 * The shared loading and empty states (spec 14 F225, F206). Two layers: the components alone,
 * and each dashboard list rendered as a route, so a list that rebuilds its own loading or empty
 * markup fails here. Wording comes from the catalogue by key, so a copy change cannot make a
 * test pass against stale text.
 */
afterEach(cleanup);

describe('Skeleton', () => {
  it('is one named busy status, so a screen reader hears the label and not grey boxes', () => {
    render(<Skeleton label="Loading integrations…" rows={2} />);
    const status = screen.getByRole('status', { name: 'Loading integrations…' });
    expect(status.getAttribute('aria-busy')).toBe('true');
  });

  it('hides every placeholder row from assistive technology, so it reads as no text at all', () => {
    const { container } = render(<Skeleton label="Loading" rows={3} />);
    const rows = container.querySelectorAll('.state-skeleton-row');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('draws three rows unless a screen asks for another number', () => {
    const { container } = render(<Skeleton label="Loading" />);
    expect(container.querySelectorAll('.state-skeleton-row')).toHaveLength(3);
  });
});

describe('EmptyState', () => {
  it('is a region named by its heading, at the level the page asks for', () => {
    render(
      <EmptyState icon={<span />} title="No integrations yet" level={1}>
        <p>Connect a tool to start.</p>
      </EmptyState>,
    );
    expect(screen.getByRole('region', { name: 'No integrations yet' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'No integrations yet' })).toBeTruthy();
  });

  it('defaults to a second-level heading, under the page heading', () => {
    render(<EmptyState icon={<span />} title="No sources yet" />);
    expect(screen.getByRole('heading', { level: 2, name: 'No sources yet' })).toBeTruthy();
  });

  it('hides the decorative icon, and shows the cause and the one action', () => {
    const { container } = render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="No deliveries yet"
        action={<button type="button">Clear filters</button>}
      >
        <p>Nothing has been sent yet.</p>
      </EmptyState>,
    );
    const iconWrapper = screen.getByTestId('icon').parentElement;
    expect(iconWrapper?.getAttribute('aria-hidden')).toBe('true');
    const region = screen.getByRole('region', { name: 'No deliveries yet' });
    expect(within(region).getByText('Nothing has been sent yet.')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Clear filters' })).toBeTruthy();
    expect(container.querySelector('.state-empty-action')).not.toBeNull();
  });

  it('renders no action area when it has no action', () => {
    const { container } = render(<EmptyState icon={<span />} title="No sources yet" />);
    expect(container.querySelector('.state-empty-action')).toBeNull();
  });
});

describe('dashboard lists use the shared states (F225)', () => {
  it('Integrations: a named busy status while loading, then a named empty region with its one action', async () => {
    await renderApp('/integrations', { api: { pending: ['/api/integrations'] } });
    const busy = await screen.findByRole('status', { name: en['integrations.loading'] });
    expect(busy.getAttribute('aria-busy')).toBe('true');
  });

  it('Integrations: an empty list is a region named by its heading, with the create link', async () => {
    await renderApp('/integrations', { api: { integrations: [] } });
    const region = await screen.findByRole('region', { name: en['integrations.empty.title'] });
    expect(within(region).getByRole('link', { name: en['integrations.empty.action'] })).toBeTruthy();
  });

  it('Sources: a named busy status while loading, then an empty region', async () => {
    await renderApp('/sources', { api: { pending: ['/api/sources'] } });
    const busy = await screen.findByRole('status', { name: en['sources.loading'] });
    expect(busy.getAttribute('aria-busy')).toBe('true');
  });

  it('Sources: an empty list is a region named by its heading', async () => {
    await renderApp('/sources', { api: { sources: [] } });
    expect(await screen.findByRole('region', { name: en['sources.empty.title'] })).toBeTruthy();
  });

  it('Activity: a named busy status while loading, then an empty region', async () => {
    await renderApp('/activity', { api: { pending: ['/api/deliveries'] } });
    const busy = await screen.findByRole('status', { name: en['deliveries.loading'] });
    expect(busy.getAttribute('aria-busy')).toBe('true');
  });

  it('Activity: with filters on, an empty result offers the one clear action', async () => {
    await renderApp('/activity?state=dead_lettered', { api: { deliveries: [] } });
    const region = await screen.findByRole('region', { name: en['deliveries.empty.filtered.title'] });
    expect(within(region).getByRole('button', { name: en['deliveries.filter.clear'] })).toBeTruthy();
  });

  it('Audit: a named busy status while loading, then an empty region', async () => {
    await renderApp('/audit', { api: { pending: ['/api/audit'] } });
    const busy = await screen.findByRole('status', { name: en['audit.loading'] });
    expect(busy.getAttribute('aria-busy')).toBe('true');
  });

  it('Audit: an empty log is a region named by its heading', async () => {
    await renderApp('/audit', { api: { audit: [] } });
    expect(await screen.findByRole('region', { name: en['audit.empty.none.title'] })).toBeTruthy();
  });

  it('Audit: a member sees the forbidden state as a named region, not an empty log', async () => {
    await renderApp('/audit', { api: { me: MEMBER } });
    expect(await screen.findByRole('region', { name: en['audit.forbidden.title'] })).toBeTruthy();
  });

  it('the loading label is translated, so the status is named in Vietnamese too', async () => {
    await renderApp('/integrations', { locale: 'vi', api: { pending: ['/api/integrations'] } });
    const label = catalogues.vi['integrations.loading'];
    if (typeof label !== 'string') throw new Error('integrations.loading is not a plain string in vi');
    const busy = await screen.findByRole('status', { name: label });
    expect(busy.getAttribute('aria-busy')).toBe('true');
  });
});

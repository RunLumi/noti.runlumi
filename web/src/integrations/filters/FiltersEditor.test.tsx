import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilterTester } from './FilterTester';
import { FiltersEditor } from './FiltersEditor';
import { EMPTY_FILTER_DRAFT } from './model';

const noop = () => undefined;
const render = (errors = {}, draft = EMPTY_FILTER_DRAFT) =>
  renderToStaticMarkup(<FiltersEditor draft={draft} errors={errors} onChange={noop} />);

describe('FiltersEditor markup', () => {
  const html = render();

  it('groups controls in fieldsets with legends', () => {
    expect(html.match(/<fieldset/g)?.length).toBeGreaterThanOrEqual(5);
    for (const legend of [
      'Branches',
      'Pull request target',
      'People and bots',
      'Draft pull requests',
      'Labels',
    ])
      expect(html).toContain(`>${legend}</legend>`);
  });

  it('gives every textarea a visible label and a hint wired with aria-describedby', () => {
    const areas = html.match(/<textarea[^>]*>/g) ?? [];
    expect(areas).toHaveLength(8);
    for (const area of areas) {
      const id = /id="([^"]+)"/.exec(area)?.[1];
      expect(id).toBeTruthy();
      expect(html).toContain(`for="${id}"`);
      expect(area).toContain('aria-describedby');
    }
  });

  it('offers bot handling as three radio choices and drafts as one checkbox', () => {
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('Skip them');
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
  });

  it('marks an invalid control and announces its message', () => {
    const bad = render({ branchAllow: 'Line 1: nope.' });
    expect(bad).toContain('aria-invalid="true"');
    expect(bad).toContain('role="alert"');
    expect(bad).toContain('Line 1: nope.');
    expect(html).not.toContain('aria-invalid');
  });

  it('shows a form-level error when the server rejects the whole set', () => {
    expect(render({ form: 'Too many.' })).toContain('Too many.');
  });
});

describe('FilterTester markup', () => {
  it('says it sends nothing, and disables the check while the filters are invalid', () => {
    const valid = renderToStaticMarkup(<FilterTester config={{}} />);
    expect(valid).toContain('nothing is sent');
    expect(valid).toContain('role="status"');
    expect(valid).not.toContain('aria-disabled');
    const invalid = renderToStaticMarkup(<FilterTester config={null} />);
    expect(invalid).toContain('aria-disabled="true"');
    expect(invalid).toContain('Fix the highlighted filters');
  });
});

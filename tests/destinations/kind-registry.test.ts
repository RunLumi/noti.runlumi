import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../../src/connectors/destinations/adapters';
import { capabilitiesFor } from '../../src/connectors/destinations/capabilities';
import { destinationAvailable } from '../../src/connectors/destinations/features';
import {
  DESTINATION_FEATURES,
  DESTINATION_KINDS,
  DESTINATION_REGISTRY,
  NOT_OFFERED,
  isDestinationKind,
  requestedFeatureIssues,
  type ReferenceSource,
} from '../../src/connectors/destinations/kind-registry';
import { renderCapabilitiesDoc } from '../../src/connectors/destinations/render-capabilities';
import { en } from '../../web/src/i18n';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const REFERENCE = read('docs/DESTINATION_API_REFERENCE.md');

/**
 * The text of one numbered section of the reference, from its heading to the next heading of the
 * same or a higher level. `2.2` matches `### 2.2 …`; `4` matches `## 4. …`.
 */
function referenceSection(section: string): string | undefined {
  const lines = REFERENCE.split('\n');
  const escaped = section.replaceAll('.', '\\.');
  const start = lines.findIndex((l) => new RegExp(`^(#{2,3}) ${escaped}(\\.|\\s)`).test(l));
  if (start < 0) return undefined;
  const level = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 2;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = /^(#+) /.exec(l);
    return m !== null && (m[1]?.length ?? 9) <= level;
  });
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const allSources = (): { where: string; source: ReferenceSource }[] =>
  DESTINATION_KINDS.flatMap((kind) => {
    const r = DESTINATION_REGISTRY[kind];
    return [
      ...r.limits.flatMap((l) => (l.source ? [{ where: `${kind}.limits.${l.id}`, source: l.source }] : [])),
      ...r.openQuestions.map((q, i) => ({ where: `${kind}.openQuestions[${String(i)}]`, source: q.source })),
      ...(r.confirmation.source ? [{ where: `${kind}.confirmation`, source: r.confirmation.source }] : []),
    ];
  }).concat(NOT_OFFERED.map((n) => ({ where: `notOffered.${n.name}`, source: n.source })));

describe('destination kind registry (F105)', () => {
  it('has exactly one entry per kind, keyed by its own kind', () => {
    expect(Object.keys(DESTINATION_REGISTRY).sort()).toEqual([...DESTINATION_KINDS].sort());
    for (const kind of DESTINATION_KINDS) {
      const r = DESTINATION_REGISTRY[kind];
      expect(r.kind).toBe(kind);
      expect(r.capabilities.kind).toBe(kind);
      expect(r.nameKey).toBe(`destination.${kind}`);
      expect(capabilitiesFor(kind)).toBe(r.capabilities);
    }
  });

  it('every registered kind has an adapter bound to that kind', () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual([...DESTINATION_KINDS].sort());
    for (const kind of DESTINATION_KINDS) {
      const adapter = ADAPTERS[kind];
      expect(adapter.kind).toBe(kind);
      for (const method of ['capabilities', 'validateConfig', 'render', 'buildRequest', 'classifyResponse'])
        expect(typeof (adapter as unknown as Record<string, unknown>)[method], `${kind}.${method}`).toBe(
          'function',
        );
    }
  });

  it('every adapter module in the tree is registered', async () => {
    const dir = join(root, 'src/connectors/destinations');
    const modules = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'adapter.ts')))
      .map((d) => d.name);
    expect(modules.length).toBeGreaterThan(0);
    const registered = new Set<unknown>(Object.values(ADAPTERS));
    for (const name of modules) {
      const mod = (await import(`../../src/connectors/destinations/${name}/adapter.ts`)) as Record<
        string,
        unknown
      >;
      const adapters = Object.values(mod).filter(
        (v) => typeof v === 'object' && v !== null && 'classifyResponse' in v && 'kind' in v,
      );
      expect(adapters.length, `${name}/adapter.ts exports an adapter`).toBeGreaterThan(0);
      for (const adapter of adapters)
        expect(registered.has(adapter), `${name}/adapter.ts is registered`).toBe(true);
    }
  });

  it('the display name matches the English catalogue', () => {
    for (const kind of DESTINATION_KINDS)
      expect(DESTINATION_REGISTRY[kind].label).toBe(en[`destination.${kind}`]);
  });

  it('knows only the registered kinds', () => {
    for (const kind of DESTINATION_KINDS) expect(isDestinationKind(kind)).toBe(true);
    for (const other of ['telegram', 'email', 'msteams', '', null, 1])
      expect(isDestinationKind(other)).toBe(false);
  });

  it('gates only the custom webhook, on the exact string "true"', () => {
    expect(DESTINATION_KINDS.filter((k) => DESTINATION_REGISTRY[k].availability.gate !== 'none')).toEqual([
      'generic_webhook',
    ]);
    expect(destinationAvailable('generic_webhook', {})).toBe(false);
    expect(destinationAvailable('generic_webhook', { GENERIC_WEBHOOK_ENABLED: 'TRUE' })).toBe(false);
    expect(destinationAvailable('generic_webhook', { GENERIC_WEBHOOK_ENABLED: 'true' })).toBe(true);
    for (const k of ['lark', 'slack', 'teams', 'discord'] as const)
      expect(destinationAvailable(k, {})).toBe(true);
  });

  it('only Lark takes a pasted signing secret and only the custom webhook generates one', () => {
    expect(
      DESTINATION_KINDS.filter((k) => DESTINATION_REGISTRY[k].signingSecret === 'customer_optional'),
    ).toEqual(['lark']);
    expect(
      DESTINATION_KINDS.filter((k) => DESTINATION_REGISTRY[k].signingSecret === 'noti_generated'),
    ).toEqual(['generic_webhook']);
    for (const k of DESTINATION_KINDS)
      expect(DESTINATION_REGISTRY[k].signingSecret !== 'none').toBe(capabilitiesFor(k).signing !== 'none');
  });
});

describe('recorded limits (F105, F119)', () => {
  it('each enforced limit equals the capability that enforces it, and each cap has one', () => {
    for (const kind of DESTINATION_KINDS) {
      const r = DESTINATION_REGISTRY[kind];
      for (const field of ['maxBodyBytes', 'maxTitleChars', 'maxTextChars'] as const) {
        const enforcing = r.limits.filter((l) => l.enforcedAs === field);
        expect(enforcing, `${kind}.${field}`).toHaveLength(1);
        expect(enforcing[0]?.value, `${kind}.${field}`).toBe(r.capabilities[field]);
      }
    }
  });

  it('a provider or derived limit cites the reference; a Noti budget or unstated value does not', () => {
    for (const kind of DESTINATION_KINDS)
      for (const l of DESTINATION_REGISTRY[kind].limits) {
        const cites = l.basis === 'provider' || l.basis === 'derived';
        expect(l.source !== undefined, `${kind}.${l.id}`).toBe(cites);
        if (l.basis === 'not_stated') expect(l.note, `${kind}.${l.id}`).toBeTruthy();
      }
  });

  it('every citation names a section of DESTINATION_API_REFERENCE.md and quotes it verbatim', () => {
    const sources = allSources();
    expect(sources.length).toBeGreaterThan(10);
    for (const { where, source } of sources) {
      const text = referenceSection(source.section);
      expect(text, `${where}: no section ${source.section}`).toBeDefined();
      expect(text, `${where}: excerpt not found in section ${source.section}`).toContain(source.excerpt);
    }
  });

  it('the section finder stops at the next heading', () => {
    expect(referenceSection('2.2')).not.toContain('### 2.3');
    expect(referenceSection('4')).toContain('Embed limits');
    expect(referenceSection('4')).not.toContain('## 5. Telegram');
    expect(referenceSection('9.9')).toBeUndefined();
  });
});

describe('save-time feature validation (F93)', () => {
  it('refuses every feature on every kind today, naming the kind', () => {
    for (const kind of DESTINATION_KINDS)
      for (const feature of Object.keys(DESTINATION_FEATURES)) {
        const issues = requestedFeatureIssues(kind, { features: [feature] });
        expect(issues).toHaveLength(1);
        expect(issues[0]?.field).toBe('features');
        expect(issues[0]?.message).toContain(DESTINATION_REGISTRY[kind].label);
      }
    expect(requestedFeatureIssues('slack', { features: ['update_in_place'] })).toEqual([
      { field: 'features', message: 'Slack in Noti does not support updating a message in place.' },
    ]);
  });

  it('refuses a format the kind cannot render, and one it renders but cannot be chosen yet', () => {
    expect(requestedFeatureIssues('generic_webhook', { format: 'plain' })).toEqual([
      { field: 'format', message: 'Custom webhook does not support the plain format. It supports: card.' },
    ]);
    const [notYet] = requestedFeatureIssues('slack', { format: 'plain' });
    expect(notYet?.message).toMatch(/^Choosing the plain format is not available yet\./);
    expect(requestedFeatureIssues('slack', { format: 'html' })[0]?.message).toBe(
      'Use card, markdown or plain.',
    );
  });

  it('accepts the default format and an empty feature list as no-ops', () => {
    for (const kind of DESTINATION_KINDS) {
      expect(requestedFeatureIssues(kind, { format: capabilitiesFor(kind).formats[0] })).toEqual([]);
      expect(requestedFeatureIssues(kind, { features: [] })).toEqual([]);
      expect(requestedFeatureIssues(kind, {})).toEqual([]);
    }
  });

  it('rejects malformed and unknown feature lists without echoing them', () => {
    expect(requestedFeatureIssues('lark', { features: 'mentions' })).toEqual([
      { field: 'features', message: 'Send a list of feature names.' },
    ]);
    const unknown = requestedFeatureIssues('lark', { features: ['<script>', 'toString'] });
    expect(unknown).toHaveLength(2);
    expect(JSON.stringify(unknown)).not.toContain('<script>');
    expect(
      requestedFeatureIssues('lark', { features: Array.from({ length: 50 }, () => 'mentions') }),
    ).toEqual([{ field: 'features', message: 'Send a list of feature names.' }]);
  });
});

describe('docs/CAPABILITIES.md (F120)', () => {
  it('is the generator output (run `npm run docs:capabilities`)', () => {
    expect(read('docs/CAPABILITIES.md')).toBe(renderCapabilitiesDoc());
  });

  it('says Teams is accepted only, lists unknowns, and keeps Telegram out of the matrix', () => {
    const doc = renderCapabilitiesDoc();
    const matrixHeader = doc.split('\n').find((l) => l.startsWith('| | ')) ?? '';
    expect(matrixHeader).not.toContain('Telegram');
    expect(doc).toContain('**Accepted only**: HTTP 202');
    expect(doc).toMatch(/## Not offered[\s\S]*\*\*Telegram\.\*\*/);
    expect(doc).toContain('## What is not known');
    expect(doc).toContain('⚠️ Not stated in the reference');
    for (const kind of DESTINATION_KINDS) expect(matrixHeader).toContain(DESTINATION_REGISTRY[kind].label);
  });
});

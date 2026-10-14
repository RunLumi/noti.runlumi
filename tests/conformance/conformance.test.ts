import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_DESCRIPTORS, type SourceDescriptor } from './descriptors';
import { CANONICAL_BUDGET_BYTES } from '../../src/events/canonical';
import type { CanonicalEvent } from '../../src/events/canonical';
import { EVENT_CATALOG, isCatalogSource } from '../../src/events/catalog';
import { canonicalSizeBytes, validateCanonicalEvent } from '../../src/events/validate';
import { loadFixtureJson, loadManifest, type FixtureEntry } from '../fixtures/load';
import { normalize } from './normalize';
import { createRig, type Rig } from './rig';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * The connector conformance suite (spec 05 F71, spec 06 F79): ONE table-driven suite that every
 * registered source must pass, run against the real ingress routes over the fake D1. A new
 * connector is not "supported" until it has a descriptor (src/connectors/sources/descriptors.ts),
 * a case below and a delivered fixture; the corpus gate in the replay suite then holds the rest.
 */
interface Case {
  /** A delivered fixture used as the valid request. */
  readonly fixture: string;
  /** Fields (dot paths, created when absent) that carry personal data or free text the notification must never copy. */
  readonly pii: readonly string[] | null;
  /**
   * Free-text fields set to long but ALLOWED values (an emoji straddling every cut point), so the
   * mapper's own cut path runs and must leave a valid event. Values the contract refuses up front
   * would not exercise it.
   */
  readonly long: Readonly<Record<string, string>>;
  /** The path in the body where the provider's own event id sits, when the protocol puts it there. */
  readonly idInBody?: string;
}

const CASES: Readonly<Record<string, Case>> = {
  github: {
    fixture: 'github/pull_request.opened',
    pii: [
      'sender.email',
      'sender.name',
      'pull_request.body',
      'pull_request.user.email',
      'repository.description',
      'pull_request.head.repo.description',
    ],
    long: {
      'pull_request.title': 'x'.repeat(297) + '\u{1f600}'.repeat(40),
      'sender.login': 'l'.repeat(97) + '\u{1f600}'.repeat(20),
      'pull_request.head.ref': 'b'.repeat(250),
      'pull_request.base.ref': 'b'.repeat(250),
      'pull_request.html_url': `https://example.test/${'u'.repeat(2000)}`,
    },
  },
  generic: {
    fixture: 'generic/flat',
    pii: null,
    long: {
      title: 'x'.repeat(298) + '\u{1f600}',
      summary: 'x'.repeat(278) + '\u{1f600}tail',
      actor: 'a'.repeat(98) + '\u{1f600}',
      type: 'a'.repeat(100),
    },
  },
  gitlab: {
    fixture: 'gitlab/push',
    pii: ['user_email', 'user_name', 'commits.0.author.email', 'commits.0.message', 'project.description'],
    long: {
      ref: 'r'.repeat(5000),
      user_username: 'u'.repeat(97) + '\u{1f600}'.repeat(20),
      'project.path_with_namespace': `a/${'p'.repeat(5000)}`,
      'commits.0.title': 'x'.repeat(117) + '\u{1f600}'.repeat(30),
    },
  },
  stripe: {
    fixture: 'stripe/invoice.payment_failed',
    pii: [
      'data.object.customer_email',
      'data.object.customer_name',
      'data.object.customer_phone',
      'data.object.description',
      'data.object.customer_address.line1',
    ],
    long: {
      'data.object.number': 'N'.repeat(37) + '\u{1f600}'.repeat(30),
      'data.object.customer': `cus_${'c'.repeat(5000)}`,
    },
  },
};

const manifest = loadManifest();
const entryOf = (id: string): FixtureEntry => {
  const e = manifest.find((m) => m.id === id);
  if (!e) throw new Error(`no fixture ${id}`);
  return e;
};

afterEach(() => vi.unstubAllGlobals());

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const holder = node;
    const next = holder[part];
    if (typeof next === 'object' && next !== null) node = next as Record<string, unknown>;
    else {
      const made: Record<string, unknown> = {};
      holder[part] = made;
      node = made;
    }
  }
  node[parts[parts.length - 1] as string] = value;
}

const writes = (rig: Rig): number => rig.count('deliveries') + rig.count('notification_outbox');

describe.each(SOURCE_DESCRIPTORS.map((d) => [d.kind, d] as const))(
  'connector conformance: %s',
  (_kind, d: SourceDescriptor) => {
    const c = CASES[d.kind] as Case;
    const entry = entryOf(c.fixture);
    const valid = (rig: Rig) => rig.encode(loadFixtureJson(entry));

    it('declares a sane descriptor and a closed catalogue that matches the registry', () => {
      expect(d.adapterVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(d.maxBodyBytes).toBeGreaterThan(0);
      expect(d.maxBodyBytes).toBeLessThanOrEqual(1024 * 1024);
      if (isCatalogSource(d.kind)) {
        expect(d.eventCatalog).toEqual(EVENT_CATALOG[d.kind].map((t) => t.type));
        expect(new Set(d.eventCatalog).size).toBe(d.eventCatalog?.length);
      } else {
        expect(d.eventCatalog).toBeNull();
      }
    });

    it('accepts the valid fixture, durably, with 202', async () => {
      const rig = await createRig(d.kind, worker);
      const res = await rig.post(valid(rig), { headers: entry.headers });
      expect(res.status).toBe(202);
      expect(rig.count('deliveries')).toBeGreaterThan(0);
      expect(rig.count('notification_outbox')).toBe(rig.count('deliveries'));
    });

    describe('verify before parse', () => {
      it.each(['forged', 'none'] as const)(
        'an unauthenticated request (%s) is 401 even with an unparseable body',
        async (signature) => {
          const rig = await createRig(d.kind, worker);
          const res = await rig.post('{"truncated":', { headers: entry.headers, signature });
          expect(res.status).toBe(401);
          expect(writes(rig)).toBe(0);
        },
      );

      it('an unauthenticated request with a valid body is 401 and writes nothing', async () => {
        const rig = await createRig(d.kind, worker);
        const res = await rig.post(valid(rig), { headers: entry.headers, signature: 'forged' });
        expect(res.status).toBe(401);
        expect(writes(rig)).toBe(0);
      });

      it('a body altered after signing is 401', async () => {
        const rig = await createRig(d.kind, worker);
        const body = valid(rig);
        const res = await rig.post(`${body} `, { headers: entry.headers, signedText: body });
        expect(res.status).toBe(401);
        expect(writes(rig)).toBe(0);
      });

      it('only an authenticated, unparseable body reaches the parser: 400', async () => {
        const rig = await createRig(d.kind, worker);
        const res = await rig.post('{"truncated":', { headers: entry.headers });
        expect(res.status).toBe(400);
        expect(writes(rig)).toBe(0);
      });
    });

    describe('size cap', () => {
      it('a body over the cap is 413 and writes nothing', async () => {
        const rig = await createRig(d.kind, worker);
        const res = await rig.post(new Uint8Array(d.maxBodyBytes + 1).fill(0x20), {
          headers: entry.headers,
          signature: 'none',
        });
        expect(res.status).toBe(413);
        expect(writes(rig)).toBe(0);
      });

      it('a chunked body with no length header is cut off at the cap too', async () => {
        const rig = await createRig(d.kind, worker);
        const big = new Uint8Array(d.maxBodyBytes + 1).fill(0x20);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(big);
            controller.close();
          },
        });
        const headers = new Headers({ ...entry.headers, 'content-type': 'application/json' });
        const res = await worker.fetch(
          new Request(`https://noti.test${rig.path}`, {
            method: 'POST',
            headers,
            body: stream,
            // @ts-expect-error duplex is required by Node's fetch for stream bodies
            duplex: 'half',
          }),
          rig.h.env,
          {
            waitUntil: rig.h.waitUntil,
            passThroughOnException: () => undefined,
          } as unknown as ExecutionContext,
        );
        expect(res.status).toBe(413);
      });
    });

    describe('content type', () => {
      if (d.kind === 'github') {
        // GitHub can be configured to send application/x-www-form-urlencoded (`payload=<json>`). The
        // route does not gate on the header: it verifies the raw bytes and then needs JSON, so a
        // form-encoded body is refused as unparseable (400) and a JSON body is accepted whatever the
        // header says. Documented in spec 05 F59.
        it('a form-encoded delivery is refused (400) after verification and writes nothing', async () => {
          const rig = await createRig(d.kind, worker);
          const body = `payload=${encodeURIComponent(valid(rig))}`;
          const res = await rig.post(body, {
            headers: entry.headers,
            contentType: 'application/x-www-form-urlencoded',
          });
          expect(res.status).toBe(400);
          expect(writes(rig)).toBe(0);
        });
      } else {
        it('a non-JSON content type is 415 before anything is written', async () => {
          const rig = await createRig(d.kind, worker);
          const res = await rig.post(valid(rig), { headers: entry.headers, contentType: 'text/plain' });
          expect(res.status).toBe(415);
          expect(writes(rig)).toBe(0);
        });
      }
    });

    describe('replay and idempotency', () => {
      if (d.replayWindowSeconds !== null) {
        const window = d.replayWindowSeconds;
        it('refuses a signed timestamp outside the window, in both directions', async () => {
          const rig = await createRig(d.kind, worker);
          const now = Math.floor(Date.now() / 1000);
          for (const ts of [now - window - 60, now + window + 60]) {
            const res = await rig.post(valid(rig), { headers: entry.headers, timestamp: ts });
            expect(res.status).toBe(401);
          }
          expect(writes(rig)).toBe(0);
        });

        it('accepts a timestamp inside the window', async () => {
          const rig = await createRig(d.kind, worker);
          const res = await rig.post(valid(rig), {
            headers: entry.headers,
            timestamp: Math.floor(Date.now() / 1000) - window + 30,
          });
          expect(res.status).toBe(202);
        });
      }

      it('the same event twice is delivered once per integration, and a fresh signature or timestamp is not a new identity', async () => {
        const rig = await createRig(d.kind, worker);
        const body = valid(rig);
        const now = Math.floor(Date.now() / 1000);
        const first = await rig.post(body, { headers: entry.headers, deliveryId: 'same-id', timestamp: now });
        const again = await rig.post(body, {
          headers: entry.headers,
          deliveryId: 'same-id',
          timestamp: now + 7,
        });
        expect(first.status).toBe(202);
        expect(again.status).toBe(202);
        const real = "state != 'suppressed'";
        const accepted = rig.count('deliveries', real);
        expect((await first.json<{ persisted: number }>()).persisted).toBe(accepted);
        expect((await again.json<{ persisted: number }>()).persisted).toBe(0);
        expect(accepted).toBeGreaterThan(0);
        expect(rig.count('deliveries', real)).toBe(accepted);
        expect(rig.count('notification_outbox')).toBe(accepted);
        // The repeat is not dropped: each integration records it as a suppressed row (F185).
        expect(rig.count('deliveries', "state = 'suppressed'")).toBe(accepted);
      });
    });

    describe('tenant resolution answers once', () => {
      if (d.tenantResolution === 'endpoint') {
        it('unknown, malformed and disabled endpoints are the same 404', async () => {
          const rig = await createRig(d.kind, worker);
          const body = valid(rig);
          const unknown = await rig.post(body, {
            headers: entry.headers,
            path: `/webhooks/${d.kind}/${'A'.repeat(24)}`,
          });
          const malformed = await rig.post(body, { headers: entry.headers, path: `/webhooks/${d.kind}/x` });
          rig.h.db.raw.prepare('UPDATE sources SET enabled=0').run();
          const disabled = await rig.post(body, { headers: entry.headers });
          const texts = await Promise.all([unknown, malformed, disabled].map((r) => r.text()));
          expect([unknown.status, malformed.status, disabled.status]).toEqual([404, 404, 404]);
          expect(new Set(texts).size).toBe(1);
          expect(writes(rig)).toBe(0);
        });
      } else {
        it('a missing, an unknown and a foreign-app installation are one refusal', async () => {
          const rig = await createRig(d.kind, worker);
          const json = loadFixtureJson(entry);
          const none = await rig.post(JSON.stringify({ ...json, installation: undefined }), {
            headers: entry.headers,
          });
          const unknown = await rig.post(JSON.stringify({ ...json, installation: { id: 424242 } }), {
            headers: entry.headers,
          });
          const foreign = await rig.post(JSON.stringify({ ...json, installation: { id: 1001, app_id: 1 } }), {
            headers: entry.headers,
          });
          const texts = await Promise.all([none, unknown, foreign].map((r) => r.text()));
          expect([none.status, unknown.status, foreign.status]).toEqual([403, 403, 403]);
          expect(new Set(texts).size).toBe(1);
          expect(writes(rig)).toBe(0);
        });
      }
    });

    describe('canonical mapping', () => {
      const json = () => loadFixtureJson(entry);

      it('is deterministic: the same input maps to byte-identical output', () => {
        const a = normalize(d.kind, entry.headers, json());
        const b = normalize(d.kind, entry.headers, json());
        expect(a).not.toBeNull();
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(validateCanonicalEvent(a).ok).toBe(true);
        expect(a?.adapterversion).toBe(d.adapterVersion);
      });

      if (c.pii) {
        it('carries no payload body and none of the personal data that was in the payload', () => {
          const body = json();
          const markers = c.pii?.map((path, i) => {
            const marker = `PII-MARKER-${i}-${d.kind}`;
            setPath(body, path, path.endsWith('email') ? `${marker}@example.invalid` : marker);
            return marker;
          });
          const canonical = normalize(d.kind, entry.headers, body);
          expect(canonical).not.toBeNull();
          const text = JSON.stringify(canonical);
          for (const marker of markers ?? []) expect(text, marker).not.toContain(marker);
          expect(text).not.toMatch(/PII-MARKER/);
        });
      } else {
        it('refuses a field the contract does not document instead of copying it', async () => {
          const rig = await createRig(d.kind, worker);
          const res = await rig.post(JSON.stringify({ ...json(), secretnote: 'PII-MARKER' }), {
            headers: entry.headers,
          });
          expect(res.status).toBe(400);
          expect(writes(rig)).toBe(0);
        });
      }

      it('stays valid and bounded when free text is long, with an emoji at every cut point', () => {
        const body = json();
        for (const [path, value] of Object.entries(c.long)) setPath(body, path, value);
        const canonical = normalize(d.kind, entry.headers, body);
        // Long but allowed: the event must still be built, never refused for our own cut.
        expect(canonical).not.toBeNull();
        const verdict = validateCanonicalEvent(canonical);
        expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
        expect(canonicalSizeBytes(canonical as CanonicalEvent)).toBeLessThan(CANONICAL_BUDGET_BYTES);
      });

      it('the long event is accepted by the route, not refused', async () => {
        const rig = await createRig(d.kind, worker);
        const body = json();
        for (const [path, value] of Object.entries(c.long)) setPath(body, path, value);
        const res = await rig.post(rig.encode(body), { headers: entry.headers });
        expect(res.status).toBeLessThan(300);
        expect(rig.count('deliveries')).toBeGreaterThan(0);
      });

      it('never produces a type outside its closed catalogue', () => {
        const types = manifest
          .filter((e) => e.provider === d.kind)
          .map((e) => normalize(d.kind, e.headers, loadFixtureJson(e)))
          .filter((e) => e !== null)
          .map((e) => e.type);
        expect(types.length).toBeGreaterThan(0);
        const prefix = `io.lumi.noti.${d.kind}.`;
        for (const type of types) {
          expect(type.startsWith(prefix)).toBe(true);
          if (d.eventCatalog) expect(d.eventCatalog).toContain(type.slice(prefix.length));
        }
      });
    });

    if (d.eventCatalog) {
      it('acknowledges a verified event outside the catalogue and writes nothing', async () => {
        const unsupported = manifest.find((m) => m.provider === d.kind && m.expect === 'ignored');
        expect(unsupported).toBeDefined();
        const rig = await createRig(d.kind, worker);
        const res = await rig.post(rig.encode(loadFixtureJson(unsupported as FixtureEntry)), {
          headers: (unsupported as FixtureEntry).headers,
        });
        expect(res.status).toBeLessThan(300);
        expect(writes(rig)).toBe(0);
      });
    }
  },
);

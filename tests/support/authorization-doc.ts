import { can, DOMAIN_CAPABILITIES } from '../../src/auth/permissions';
import { ROUTE_POLICY, type RouteAccess } from '../../src/auth/route-policy';

/**
 * Renders the two generated tables of docs/AUTHORIZATION.md from the code that enforces them:
 * `src/auth/permissions.ts` (roles x capabilities) and `src/auth/route-policy.ts` (routes).
 * `tests/security/authorization-doc.test.ts` fails when the committed file differs.
 */
const yes = (b: boolean): string => (b ? 'yes' : 'no');

export function describeAccess(access: RouteAccess): string {
  switch (access.kind) {
    case 'capability':
      return `capability \`${access.capability}\``;
    case 'member':
      return 'any member of the resolved workspace';
    case 'session':
      return 'signed-in session; membership checked in the handler';
    case 'self':
      return "the caller's own account (user id from the verified session)";
    case 'signed-webhook':
      return `signed webhook (\`${access.verifiedBy.replace(/\($/, '')}\`)`;
    case 'auth-handler':
      return 'Better Auth';
    case 'public':
      return 'public';
  }
}

export function renderCapabilityTable(): string {
  const rows = DOMAIN_CAPABILITIES.map((capability) => {
    const routes = ROUTE_POLICY.filter(
      (p) => p.access.kind === 'capability' && p.access.capability === capability,
    ).map((p) => `\`${p.method} ${p.path}\``);
    return `| \`${capability}\` | ${yes(can('admin', capability))} | ${yes(can('member', capability))} | ${routes.join('<br>')} |`;
  });
  return ['| Capability | admin | member | Required by |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

export function renderRouteTable(): string {
  const rows = ROUTE_POLICY.map(
    (p) => `| \`${p.method} ${p.path}\` | ${describeAccess(p.access)} | \`${p.file}\` |`,
  );
  return ['| Route | Guard | Handler |', '| --- | --- | --- |', ...rows].join('\n');
}

export const BEGIN = (name: string): string => `<!-- BEGIN GENERATED: ${name} -->`;
export const END = (name: string): string => `<!-- END GENERATED: ${name} -->`;

/** Replace the text between the markers of `name`; null when a marker is missing. */
export function replaceBlock(doc: string, name: string, body: string): string | null {
  const start = doc.indexOf(BEGIN(name));
  const end = doc.indexOf(END(name));
  if (start < 0 || end < start) return null;
  return `${doc.slice(0, start + BEGIN(name).length)}\n\n${body}\n\n${doc.slice(end)}`;
}

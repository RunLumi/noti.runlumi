import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

export const ac = createAccessControl(defaultStatements);
export const roles = {
  admin: ac.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  member: ac.newRole({}),
} as const;
export type OrgRole = keyof typeof roles;
export function isOrgRole(value: unknown): value is OrgRole {
  return value === "admin" || value === "member";
}

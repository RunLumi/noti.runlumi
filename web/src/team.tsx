import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { UserPlus, Users, LogOut } from "lucide-react";
import { authClient, assertAuthSuccess } from "./lib/auth-client";
import { api, authApi } from "./lib/api";
import { Badge, Button, Card, Input } from "./components/ui";

type Member = { id: string; userId: string; name: string; email: string; role: "admin" | "member"; createdAt: string };
export function TeamManagement() {
  const me = useQuery({ queryKey: ["me"], queryFn: authApi.me });
  const team = useQuery({
    queryKey: ["team"],
    queryFn: () => api<{ members: Member[] }>("/api/workspace/team"),
    enabled: Boolean(me.data?.user.org_id),
  });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const orgId = me.data?.user.org_id;
  const isAdmin = me.data?.user.role === "admin";
  const refresh = () => qc.invalidateQueries({ queryKey: ["team"] });

  async function invite(e: FormEvent) {
    e.preventDefault(); if (!orgId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      assertAuthSuccess(await authClient.organization.inviteMember({
        email: email.trim().toLowerCase(), role, organizationId: orgId,
      }));
      setEmail("");
      setMessage("Invitation sent. The recipient must verify their email to join.");
    } catch (e) { setError(e instanceof Error ? e.message : "Invite failed"); }
    finally { setBusy(false); }
  }
  async function changeRole(memberId: string, newRole: "admin" | "member") {
    if (!orgId) return;
    setError("");
    try {
      assertAuthSuccess(await authClient.organization.updateMemberRole({
        memberId, role: newRole, organizationId: orgId,
      }));
      await refresh(); await qc.invalidateQueries({ queryKey: ["me"] });
    } catch(e) { setError(e instanceof Error ? e.message : "Role change rejected"); }
  }
  async function remove(memberId: string) {
    if (!orgId || !window.confirm("Remove this person from your organization?")) return;
    setError("");
    try {
      assertAuthSuccess(await authClient.organization.removeMember({
        memberIdOrEmail: memberId, organizationId: orgId,
      }));
      await refresh();
    } catch(e) { setError(e instanceof Error ? e.message : "Cannot remove member"); }
  }
  async function leave() {
    if (!orgId || !window.confirm("Leave this organization? The last admin cannot leave.")) return;
    setError("");
    try {
      assertAuthSuccess(await authClient.organization.leave({ organizationId: orgId }));
      await qc.invalidateQueries({ queryKey: ["me"] });
      await navigate({ to: "/onboarding" });
    } catch (e) { setError(e instanceof Error ? e.message : "Cannot leave the organization"); }
  }
  return <div className="team-management">
    <header className="page-header"><div><p className="eyebrow">ORGANIZATION</p>
      <h1>Team</h1><p className="muted">Manage your team and access permissions.</p></div>
    </header>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {isAdmin && <Card className="panel">
      <h2><UserPlus size={19} /> Invite someone</h2>
      <form className="invite-form" onSubmit={invite}>
        <label className="grow">Email<Input required type="email" value={email}
          placeholder="colleague@company.com" onChange={e => setEmail(e.target.value)} /></label>
        <label>Role<select className="input" value={role} onChange={e => setRole(e.target.value as "admin"|"member")}>
          <option value="member">Member</option><option value="admin">Admin</option>
        </select></label>
        <Button disabled={busy || !email.trim()} type="submit">{busy ? "Sending…" : "Send invitation"}</Button>
      </form>
    </Card>}
    <Card className="panel" style={{ marginTop: 20 }}>
      <h2><Users size={19} /> Members</h2>
      {team.isLoading ? <p>Loading members…</p> :
        team.isError ? <p role="alert">Unable to load team members.</p> :
        team.data?.members.map(m =>
          <div className="team-entry" key={m.id}>
            <div className="avatar">{(m.name || m.email)[0].toUpperCase()}</div>
            <div className="grow"><strong>{m.name || m.email}</strong><p className="muted">{m.email}</p></div>
            {isAdmin && m.userId !== me.data?.user.id ?
              <select aria-label={"Role for " + m.email} className="role-select" value={m.role}
                onChange={e => void changeRole(m.id, e.target.value as "admin"|"member")}>
                <option value="member">Member</option><option value="admin">Admin</option>
              </select> : <Badge>{m.role}</Badge>}
            {isAdmin && m.userId !== me.data?.user.id &&
              <Button variant="ghost" onClick={() => void remove(m.id)}>Remove</Button>}
          </div>
        )}
    </Card>
    <Card className="panel" style={{ marginTop: 20 }}>
      <h2>Membership</h2>
      <p className="muted">You may leave when another admin remains in the organization.</p>
      <Button variant="outline" onClick={() => void leave()}><LogOut size={16}/> Leave organization</Button>
    </Card>
  </div>;
}

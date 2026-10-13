import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, MailCheck, UserPlus } from "lucide-react";
import { authClient, assertAuthSuccess } from "./lib/auth-client";
import { authApi } from "./lib/api";
import { Card, Button, Input } from "./components/ui";

function slug(name: string): string {
  return name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 36) || "team";
}
export function OnboardingPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      assertAuthSuccess(await authClient.organization.create({
        name: name.trim(),
        slug: slug(name) + "-" + crypto.randomUUID().slice(0, 8),
      }));
      await qc.invalidateQueries({ queryKey: ["me"] });
      await nav({ to: "/" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create workspace");
    } finally { setBusy(false); }
  }
  return <div className="onboarding">
    <Card className="panel">
      <div className="empty-icon"><Building2 /></div>
      <h1>Create your workspace</h1>
      <p className="muted">Each person belongs to one organization at a time. You can invite more people after setup.</p>
      <form onSubmit={submit} className="auth-form">
        <label>Organization name
          <Input required minLength={2} maxLength={80} value={name}
            onChange={e => setName(e.target.value)} placeholder="Your company or team" />
        </label>
        {error && <p role="alert" className="text-error">{error}</p>}
        <Button disabled={busy || name.trim().length < 2} type="submit">
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </form>
      <p className="muted">Joining an existing team? Open the invitation link you received by email instead.</p>
    </Card>
  </div>;
}

export function InvitePage() {
  const id = new URLSearchParams(window.location.search).get("id");
  const me = useQuery({ queryKey: ["me"], queryFn: authApi.me, retry: false });
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const loginRedirect = "/signin?returnTo=" + encodeURIComponent("/invite?id=" + (id || ""));
  async function accept() {
    if (!id) return;
    setError(""); setBusy(true);
    try {
      assertAuthSuccess(await authClient.organization.acceptInvitation({ invitationId: id }));
      await qc.invalidateQueries({ queryKey: ["me"] });
      await nav({ to: "/" });
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to join organization"); }
    finally { setBusy(false); }
  }
  return <div className="invite-screen"><Card className="panel">
    <div className="empty-icon"><UserPlus /></div><h1>Team invitation</h1>
    {!id ? <p role="alert">Invitation link is missing an ID.</p> :
      me.isPending ? <p>Checking your account…</p> :
        me.isError ? <>
          <p>Sign in with the email address that received this invitation. Verify that email before accepting.</p>
          <a className="btn btn-primary" href={loginRedirect}>Sign in to accept</a>
          <p><Link to="/signup">New to Lumi Noti? Create an account</Link></p>
        </> : me.data.user.org_id ? <p role="alert">
          You already belong to an organization. Leave it before accepting this invitation.
        </p> : <>
          <p className="muted">You're signed in as {me.data.user.email}. Accepting joins the inviting organization.</p>
          <Button disabled={busy} onClick={()=>void accept()}>{busy ? "Joining…" : "Accept invitation"}</Button>
        </>}
    {error && <p role="alert" className="text-error">{error}</p>}
  </Card></div>;
}

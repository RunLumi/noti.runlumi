import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, Plus } from "lucide-react";
import { authClient, assertAuthSuccess } from "./lib/auth-client";
import { Button, Card } from "./components/ui";
export function PasskeysPanel() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [info, setInfo] = useState("");
  const keys = useQuery({ queryKey: ["passkeys"], queryFn: async () =>
    assertAuthSuccess(await authClient.passkey.listUserPasskeys()) });
  async function add() {
    setBusy(true); setError(""); setInfo("");
    try {
      assertAuthSuccess(await authClient.passkey.addPasskey({ name: "My passkey" }));
      await qc.invalidateQueries({ queryKey: ["passkeys"] });
      setInfo("Passkey registered successfully.");
    } catch (e) { setError(e instanceof Error ? e.message : "Passkey registration failed"); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("Delete this passkey?")) return;
    setError("");
    try { assertAuthSuccess(await authClient.passkey.deletePasskey({ id }));
      await qc.invalidateQueries({ queryKey: ["passkeys"] });
    } catch(e) { setError(e instanceof Error ? e.message : "Unable to delete passkey"); }
  }
  return <Card className="panel" style={{ marginTop: 20 }}>
    <h2><Fingerprint size={19}/> Passkeys</h2>
    <p className="muted">Sign in using your device's biometrics, PIN or security key. Register a passkey after verifying your email.</p>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {info && <p role="status" className="notice">{info}</p>}
    {keys.isLoading ? <p>Loading passkeys…</p> :
      keys.isError ? <p role="alert">Could not load passkeys.</p> :
      keys.data?.map(key => <div className="team-entry" key={key.id}>
        <Fingerprint size={20}/><div className="grow"><strong>{key.name || "Passkey"}</strong>
          <p className="muted">Created {key.createdAt ? new Date(key.createdAt).toLocaleDateString() : "recently"}</p></div>
        <Button variant="ghost" onClick={() => void remove(key.id)}>Delete</Button>
      </div>)}
    <Button variant="outline" disabled={busy} onClick={() => void add()}><Plus size={16}/>{busy ? "Registering…" : "Add passkey"}</Button>
  </Card>;
}

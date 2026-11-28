import { useState } from "preact/hooks";
import { Scissors } from "lucide-preact";
import { api } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface AuthStatus { logged_in: boolean; login_required: boolean }

export function Login({ onLoggedIn }: { onLoggedIn: (status: AuthStatus) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await api<AuthStatus>("POST", "/api/auth/login", { password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log in. Try again.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-[1.5rem] border border-hairline bg-card p-6 shadow-soft">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Scissors className="h-4 w-4" />
          </div>
          <h1 className="text-lg font-medium">Tolly</h1>
        </div>
        <p className="text-sm text-muted-foreground">Enter the staff password to open the dashboard.</p>
        <div className="space-y-2">
          <Label htmlFor="staff-password">Password</Label>
          <Input
            id="staff-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            className="min-h-11"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="min-h-11 w-full" disabled={busy || !password}>
          {busy ? "Logging in..." : "Log in"}
        </Button>
      </form>
    </div>
  );
}

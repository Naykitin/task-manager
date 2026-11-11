import { useState, type FormEvent } from "react";
import { useAuth } from "../auth.tsx";
import { ApiError } from "../api.ts";

export function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, password, inviteCode);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Something went wrong",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <span className="brand-mark">◆</span> NayFlow
          <span className="brand-by">by Naykitin</span>
        </div>
        <h1 className="auth-title">
          {mode === "login" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="auth-sub">
          {mode === "login"
            ? "Log in to your private board."
            : "Registration requires an invite code."}
        </p>

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            autoComplete="email"
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {mode === "register" && (
          <label className="field">
            <span>Invite code</span>
            <input
              type="text"
              value={inviteCode}
              required
              onChange={(e) => setInviteCode(e.target.value)}
            />
          </label>
        )}

        {error && <div className="auth-error">{error}</div>}

        <button className="btn primary block" type="submit" disabled={busy}>
          {busy
            ? "Please wait…"
            : mode === "login"
              ? "Log in"
              : "Create account"}
        </button>

        <div className="auth-switch">
          {mode === "login" ? (
            <>
              No account?{" "}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode("register");
                  setError(null);
                }}
              >
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode("login");
                  setError(null);
                }}
              >
                Log in
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

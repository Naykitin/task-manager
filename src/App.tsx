import { useEffect, useState } from "react";
import { startLive } from "./live.ts";
import { useAuth } from "./auth.tsx";
import { AuthPage } from "./components/AuthPage.tsx";
import { BoardView } from "./components/BoardView.tsx";
import { Timesheet } from "./components/Timesheet.tsx";
import { PomodoroBar } from "./components/PomodoroBar.tsx";
import { Settings } from "./components/Settings.tsx";

type View = "board" | "timesheet" | "settings";

export function App() {
  const { user, loading, logout } = useAuth();
  const [view, setView] = useState<View>("board");

  // Keep this tab in sync with changes made on other devices.
  const signedIn = Boolean(user);
  useEffect(() => (signedIn ? startLive() : undefined), [signedIn]);

  if (loading) {
    return (
      <div className="center-screen">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) return <AuthPage />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span> NayFlow
          <span className="brand-by">by Naykitin</span>
        </div>
        <nav className="tabs">
          <button
            className={view === "board" ? "tab active" : "tab"}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            className={view === "timesheet" ? "tab active" : "tab"}
            onClick={() => setView("timesheet")}
          >
            Timesheet
          </button>
        </nav>
        <div className="topbar-right">
          <button
            className={view === "settings" ? "icon-btn gear active" : "icon-btn gear"}
            title="Settings"
            aria-label="Settings"
            onClick={() => setView("settings")}
          >
            {"\u2699"}
          </button>
          <span className="user-email">{user.email}</span>
          <button className="btn ghost" onClick={() => logout()}>
            Log out
          </button>
        </div>
      </header>

      <PomodoroBar />

      <main className="main">
        {view === "board" && <BoardView />}
        {view === "timesheet" && <Timesheet />}
        {view === "settings" && <Settings />}
      </main>
    </div>
  );
}

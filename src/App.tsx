import { useState } from "react";
import { useAuth } from "./auth.tsx";
import { AuthPage } from "./components/AuthPage.tsx";
import { BoardView } from "./components/BoardView.tsx";
import { Timesheet } from "./components/Timesheet.tsx";

type View = "board" | "timesheet";

export function App() {
  const { user, loading, logout } = useAuth();
  const [view, setView] = useState<View>("board");

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
          <span className="brand-mark">◆</span> Task&nbsp;Manager
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
          <span className="user-email">{user.email}</span>
          <button className="btn ghost" onClick={() => logout()}>
            Log out
          </button>
        </div>
      </header>

      <main className="main">
        {view === "board" && <BoardView />}
        {view === "timesheet" && <Timesheet />}
      </main>
    </div>
  );
}

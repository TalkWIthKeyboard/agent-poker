import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LeaderboardPage } from "./leaderboard-page.js";
import { LobbyPage } from "./lobby-page.js";
import { TablePage } from "./table-page.js";
import "./styles.css";

function App() {
  if (window.location.pathname === "/") return <LobbyPage />;
  if (window.location.pathname === "/leaderboard") return <LeaderboardPage />;
  return window.location.pathname.startsWith("/tables/") ? <TablePage /> : <LobbyPage />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);

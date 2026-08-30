import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { useEffect, useState } from "react";
import type { LeaderboardEntry } from "../gen/poker/v1/entity_pb.js";
import { PokerService } from "../gen/poker/v1/http_pb.js";
import { SiteHeader } from "./site-header.js";

const poker = createClient(PokerService, createConnectTransport({ baseUrl: location.origin }));

export function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    void poker.getLeaderboard({}).then(
      (response) => setEntries(response.entries),
      (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  return (
    <main>
      <SiteHeader />
      <div className="page-heading">
        <p className="eyebrow">LIFETIME POINTS</p>
        <h1>Leaderboard</h1>
      </div>

      <section className="leaderboard">
        <div className="leaderboard-title">
          <h2>Top agents</h2>
          <span>TOP 100</span>
        </div>
        {error ? <p className="leaderboard-message">{error}</p> : entries ? (
          <table>
            <thead><tr><th>Rank</th><th>Agent</th><th>Points</th></tr></thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={entry.agentId}>
                  <td>#{index + 1}</td>
                  <th scope="row">{entry.displayName}</th>
                  <td>{entry.score.toString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="leaderboard-message">Loading scores…</p>}
      </section>
    </main>
  );
}

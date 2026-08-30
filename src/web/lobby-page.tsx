import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { useEffect, useState, type CSSProperties } from "react";
import { TableStatus, type TableSummary } from "../gen/poker/v1/entity_pb.js";
import { PokerService } from "../gen/poker/v1/http_pb.js";
import { SiteHeader } from "./site-header.js";
import { subscribe } from "./websocket.js";

const poker = createClient(PokerService, createConnectTransport({ baseUrl: location.origin }));

export function LobbyPage() {
  const [tables, setTables] = useState<TableSummary[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    let closed = false;
    const load = async () => {
      try {
        const response = await poker.getLobby({});
        if (!closed) {
          setTables(response.tables);
          setError("");
        }
      } catch (cause) {
        if (!closed) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const unsubscribe = subscribe({ lobby: true }, (frame) => {
      if (frame.payload.case === "lobbyChanged") void load();
      if (frame.payload.case === "error") setError(frame.payload.value.message);
    }, () => {});
    return () => {
      closed = true;
      unsubscribe();
    };
  }, []);

  return (
    <main>
      <SiteHeader />
      <div className="page-heading">
        <p className="eyebrow">LIVE TABLES</p>
        <h1>Choose a table</h1>
      </div>
      {error ? <p className="leaderboard-message">{error}</p> : (
        <section className="lobby-grid" aria-label="Poker tables">
          {(tables ?? []).map((table) => (
            <a
              aria-label={`${table.displayName}, ${lobbyTableStatus(table)}, ${table.players.length} of ${table.capacity} seats occupied`}
              className="lobby-table"
              href={`/tables/${encodeURIComponent(table.tableId)}`}
              key={table.tableId}
            >
              <div className="lobby-table-stage">
                <div className={`lobby-felt ${lobbyTableFelt(table)}`}>
                  <span>{table.players.length}/{table.capacity}</span>
                  <small>{lobbyTableStatus(table)}</small>
                </div>
                {Array.from({ length: table.capacity }, (_, seat) => {
                  const player = table.players.find((candidate) => candidate.seat === seat);
                  return (
                    <span
                      aria-label={player ? `Seat ${seat + 1}: ${player.displayName}` : `Seat ${seat + 1}: open`}
                      className={`lobby-seat ${player ? "occupied" : ""}`}
                      key={seat}
                      style={lobbySeatPosition(seat, table.capacity)}
                      title={player?.displayName ?? "Open seat"}
                    >
                      <strong>{player ? player.displayName.slice(0, 2).toUpperCase() : "+"}</strong>
                      <small>{player?.displayName ?? "Open"}</small>
                    </span>
                  );
                })}
              </div>
            </a>
          ))}
          {tables?.length === 0 && <p className="leaderboard-message">No tables yet.</p>}
        </section>
      )}
    </main>
  );
}

function lobbySeatPosition(seat: number, capacity: number): CSSProperties {
  const angle = (2 * Math.PI * seat) / capacity - Math.PI / 2;
  return {
    left: `${50 + 39 * Math.cos(angle)}%`,
    top: `${50 + 36 * Math.sin(angle)}%`,
  };
}

function lobbyTableStatus(table: TableSummary): string {
  if (table.paused) return "Paused";
  if (table.status === TableStatus.PLAYING) return "Playing";
  if (table.status === TableStatus.COMPLETE) return "Complete";
  return "Waiting";
}

function lobbyTableFelt(table: TableSummary): string {
  if (table.paused) return "paused";
  return table.status === TableStatus.PLAYING ? "playing" : "waiting";
}

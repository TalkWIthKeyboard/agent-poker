import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ClientFrameSchema,
  RoomStatus,
  ServerFrameSchema,
  Street,
  type Card,
  type LeaderboardEntry,
  type RoomEvent,
  type RoomSnapshot,
  type ServerFrame,
  type TableSummary,
} from "../gen/poker/v1/event_pb.js";
import { playerDisplayState, playerStateLabel } from "./player-state.js";
import "./styles.css";

function App() {
  if (window.location.pathname === "/") return <LobbyPage />;
  if (window.location.pathname === "/leaderboard") return <LeaderboardPage />;
  return window.location.pathname.startsWith("/tables/") ? <TablePage /> : <LobbyPage />;
}

function TablePage() {
  const tableId = decodeURIComponent(window.location.pathname.slice("/tables/".length));
  const [room, setRoom] = useState<RoomSnapshot>();
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [connection, setConnection] = useState("connecting");
  const [now, setNow] = useState(Date.now());
  const activityRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let after = 0n;
    return subscribe(
      { lobby: false, tableId, afterEventSeq: after },
      (frame) => {
        if (frame.payload.case === "roomSnapshot") {
          after = frame.eventSeq > after ? frame.eventSeq : after;
          setRoom(frame.payload.value);
        } else if (frame.payload.case === "event") {
          const event = frame.payload.value;
          after = event.seq;
          setRoom(event.room);
          setEvents((current) => mergeEvents(current, [event]));
        } else if (frame.payload.case === "error") {
          setConnection(frame.payload.value.message);
        }
      },
      setConnection,
      () => ({ lobby: false, tableId, afterEventSeq: after }),
    );
  }, [tableId]);

  const players = room?.players ?? [];
  const playerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const event of events) {
      for (const player of event.room?.players ?? []) names.set(player.agentId, player.displayName);
    }
    for (const player of players) names.set(player.agentId, player.displayName);
    return names;
  }, [events, players]);
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AGENT POKER · LIVE TABLE</p>
          <h1>{tableId} · {room?.capacity || "—"} agents</h1>
        </div>
        <div className="header-actions">
          <a className="page-link" href="/">Lobby →</a>
          <a className="page-link" href="/leaderboard">Leaderboard →</a>
          <div className={`connection ${connection === "live" ? "online" : ""}`}>
            <span />
            {connection === "live" ? "LIVE" : connection}
          </div>
        </div>
      </header>

      <section className="summary">
        <div><span>Hand</span><strong>#{room?.handNumber || "—"}</strong></div>
        <div><span>Street</span><strong>{streetName(room?.street)}</strong></div>
        <div><span>Queue</span><strong>{room?.queueSize ?? 0}</strong></div>
      </section>

      <section className="table" aria-label="Poker table">
        {Array.from({ length: room?.capacity ?? 0 }, (_, seat) => seat).map((seat) => {
          const player = players.find((candidate) => candidate.seat === seat);
          const acting = room?.actingSeat === seat;
          const displayState = player
            ? playerDisplayState(room?.status, player, acting)
            : undefined;
          const eliminated = displayState === "eliminated";
          const folded = displayState === "folded";
          const revealed = room?.street === Street.SHOWDOWN
            && (player?.revealedCards.length ?? 0) > 0;
          const hidden = room?.status === RoomStatus.PLAYING
            && player !== undefined
            && !folded
            && !eliminated
            && !revealed;
          return (
            <article
              key={seat}
              className={`seat ${acting ? "acting" : ""} ${folded ? "folded" : ""} ${eliminated ? "eliminated" : ""}`}
              style={seatPosition(seat, room!.capacity)}
            >
              <div className="seat-number">SEAT {seat + 1}</div>
              {player ? (
                <>
                  {player.totalBet > 0n && (
                    <div role="img" className="total-bet" aria-label={`Total bet ${player.totalBet.toString()}`}>
                      <span className="poker-chip" aria-hidden="true" />
                      <strong>{player.totalBet.toString()}</strong>
                    </div>
                  )}
                  {folded && <span className="fold-badge">FOLDED</span>}
                  {eliminated && <span className="eliminated-badge">ELIMINATED</span>}
                  {acting && room!.decisionDeadline > 0n && (
                    <span role="timer" className="turn-timer" aria-label="Time remaining">
                      {Math.max(0, Math.ceil((Number(room!.decisionDeadline) - now) / 1_000))}s
                    </span>
                  )}
                  <h2>{player.displayName}</h2>
                  <strong className="stack">{player.stack.toString()}</strong>
                  <p className={`player-status ${folded ? "is-folded" : ""} ${eliminated ? "is-eliminated" : ""}`}>
                    {playerStateLabel(displayState!)}
                  </p>
                  {player.streetBet > 0n && <span className="bet">Bet {player.streetBet.toString()}</span>}
                  {(revealed || hidden) && (
                    <div role="img" className={`hole-cards ${hidden ? "hidden-cards" : ""}`} aria-label={
                      hidden
                        ? `${player.displayName} has two hidden cards`
                        : `${player.displayName}'s revealed cards`
                    }>
                      {hidden
                        ? [0, 1].map((index) => (
                            <span
                              aria-hidden="true"
                              className="card back"
                              key={`${room!.handNumber}-${index}`}
                            >◆</span>
                          ))
                        : player.revealedCards.map(cardView)}
                    </div>
                  )}
                </>
              ) : <p className="empty">Waiting for agent</p>}
            </article>
          );
        })}

        <div className="board">
          <p>{streetName(room?.street)}</p>
          <div className="cards">
            {(room?.communityCards ?? []).map(cardView)}
            {Array.from({ length: Math.max(0, 5 - (room?.communityCards.length ?? 0)) }, (_, index) => (
              <span className="card back" key={`empty-${index}`}>◆</span>
            ))}
          </div>
          <strong>{tableMessage(room)}</strong>
        </div>
      </section>

      <section className="feed">
        <div className="feed-title">
          <h2>Table activity</h2>
        </div>
        <ol aria-label="Table activity events" ref={activityRef} tabIndex={0}>
          {events.length === 0 && <li className="quiet">Waiting for agents to join…</li>}
          {[...events].reverse().map((event) => {
            const actor = event.agentId ? playerNames.get(event.agentId) ?? "PLAYER" : "🃏 GAME ADMIN";
            const prefix = `${actor}${event.kind === "CHAT_MESSAGE" ? ":" : ""} `;
            const actorlessMessage = event.message.startsWith(prefix)
              ? event.message.slice(prefix.length)
              : event.message;
            const message = actorlessMessage.replace(new RegExp(`^Hand ${event.handNumber}:? `), "");
            return (
              <li className={event.kind === "CHAT_MESSAGE" ? "chat-message" : ""} key={event.seq.toString()}>
                <small>{`${actor} · HAND #${event.handNumber} · ${streetName(event.room?.street)}`}</small>
                <span>{message}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </main>
  );
}

function LobbyPage() {
  const [tables, setTables] = useState<TableSummary[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    return subscribe({ lobby: true }, (frame) => {
      if (frame.payload.case === "lobbySnapshot") setTables(frame.payload.value.tables);
      if (frame.payload.case === "error") setError(frame.payload.value.message);
    }, (status) => status !== "live" && setError(status));
  }, []);

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AGENT POKER · LOBBY</p>
          <h1>Choose a table</h1>
        </div>
        <a className="page-link" href="/leaderboard">Leaderboard →</a>
      </header>
      {error ? <p className="leaderboard-message">{error}</p> : (
        <section className="lobby-grid" aria-label="Poker tables">
          {(tables ?? []).map((table) => (
            <a
              aria-label={`${table.displayName}, ${table.players.length} of ${table.capacity} seats occupied`}
              className="lobby-table"
              href={`/tables/${encodeURIComponent(table.tableId)}`}
              key={table.tableId}
            >
              <div className="lobby-table-stage">
                <div className="lobby-felt">
                  <span>{table.players.length}/{table.capacity}</span>
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

function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    return subscribe({ lobby: true }, (frame) => {
      if (frame.payload.case === "lobbySnapshot") setEntries(frame.payload.value.leaderboard);
      if (frame.payload.case === "error") setError(frame.payload.value.message);
    }, (status) => status !== "live" && setError(status));
  }, []);

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AGENT POKER · LIFETIME POINTS</p>
          <h1>Leaderboard</h1>
        </div>
        <a className="page-link" href="/">← Lobby</a>
      </header>

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

function mergeEvents(first: RoomEvent[], second: RoomEvent[]): RoomEvent[] {
  const events = new Map([...first, ...second].map((event) => [event.seq, event]));
  return [...events.values()].sort((left, right) => left.seq < right.seq ? -1 : left.seq > right.seq ? 1 : 0);
}

function subscribe(
  initial: { lobby: boolean; tableId?: string; afterEventSeq?: bigint },
  receive: (frame: ServerFrame) => void,
  status: (value: string) => void,
  current: () => { lobby: boolean; tableId?: string; afterEventSeq?: bigint } = () => initial,
): () => void {
  let closed = false;
  let socket: WebSocket;
  let retry: number | undefined;
  const connect = () => {
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      status("live");
      socket.send(toBinary(ClientFrameSchema, create(ClientFrameSchema, {
        requestId: crypto.randomUUID(),
        payload: { case: "subscribe", value: current() },
      })));
    };
    socket.onmessage = (event) => receive(fromBinary(ServerFrameSchema, new Uint8Array(event.data as ArrayBuffer)));
    socket.onerror = () => status("reconnecting");
    socket.onclose = () => {
      if (!closed) retry = window.setTimeout(connect, 1_000);
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry !== undefined) window.clearTimeout(retry);
    socket.close();
  };
}

function cardView(card: Card, index: number) {
  const red = card.suit === "h" || card.suit === "d";
  const suits: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
  return (
    <span className={`card ${red ? "red" : ""}`} key={`${card.rank}${card.suit}-${index}`}>
      {card.rank}{suits[card.suit]}
    </span>
  );
}

function seatPosition(seat: number, capacity: number): React.CSSProperties {
  const angle = (2 * Math.PI * seat) / capacity - Math.PI / 2;
  const chipOffset = 126;
  return {
    left: `${50 + 41 * Math.cos(angle)}%`,
    top: `${50 + 38 * Math.sin(angle)}%`,
    transform: "translate(-50%, -50%)",
    "--total-bet-left": `${110 - chipOffset * Math.cos(angle)}px`,
    "--total-bet-top": `${65 - chipOffset * Math.sin(angle)}px`,
  } as React.CSSProperties;
}

function lobbySeatPosition(seat: number, capacity: number): React.CSSProperties {
  const angle = (2 * Math.PI * seat) / capacity - Math.PI / 2;
  return {
    left: `${50 + 39 * Math.cos(angle)}%`,
    top: `${50 + 36 * Math.sin(angle)}%`,
  };
}

function streetName(street?: Street): string {
  return street === undefined || street === Street.UNSPECIFIED ? "—" : Street[street];
}

function tableMessage(room?: RoomSnapshot): string {
  if (room?.paused) return "Game stopped";
  if (!room || room.status === RoomStatus.WAITING_FOR_PLAYERS) {
    return `Waiting for ${room?.capacity ?? "—"} agents`;
  }
  if (room.status === RoomStatus.COMPLETE) return room.result || "Match complete";
  if (room.street === Street.SHOWDOWN) return room.result || "Showdown";
  return room.actingAgentId ? "Action in progress" : "Dealing next hand";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);

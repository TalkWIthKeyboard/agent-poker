import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PokerService,
  RoomStatus,
  Street,
  type Card,
  type LeaderboardEntry,
  type RoomEvent,
  type RoomSnapshot,
} from "../gen/poker/v1/poker_pb.js";
import { playerDisplayState, playerStateLabel } from "./player-state.js";
import "./styles.css";

const EVENT_PAGE_SIZE = 20;
const client = createClient(
  PokerService,
  createConnectTransport({ baseUrl: window.location.origin, useBinaryFormat: true }),
);

function App() {
  return window.location.pathname === "/leaderboard" ? <LeaderboardPage /> : <TablePage />;
}

function TablePage() {
  const [room, setRoom] = useState<RoomSnapshot>();
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [connection, setConnection] = useState("connecting");
  const [now, setNow] = useState(Date.now());
  const activityRef = useRef<HTMLOListElement>(null);
  const loadMoreRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let after: bigint;

    async function watch() {
      const [initial, activity] = await Promise.all([
        client.getRoom({ omitEvents: true }, { signal: controller.signal }),
        client.listRoomEvents({ limit: EVENT_PAGE_SIZE }, { signal: controller.signal }),
      ]);
      const newest = activity.events.at(-1);
      after = newest?.seq ?? initial.room?.latestEventSeq ?? 0n;
      setRoom(newest?.seq && newest.seq > (initial.room?.latestEventSeq ?? 0n)
        ? newest.room
        : initial.room);
      setEvents(activity.events);
      setHasMoreEvents(activity.hasMore);

      while (!controller.signal.aborted) {
        try {
          setConnection("live");
          for await (const response of client.watchRoom(
            { afterEventSeq: after },
            { signal: controller.signal },
          )) {
            if (!response.event) continue;
            after = response.event.seq;
            setRoom(response.event.room);
            setEvents((current) => mergeEvents(current, [response.event!]));
          }
        } catch (cause) {
          if (controller.signal.aborted) return;
          setConnection(cause instanceof Error ? cause.message : "reconnecting");
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    void watch().catch((cause) => {
      if (!controller.signal.aborted) {
        setConnection(cause instanceof Error ? cause.message : "disconnected");
      }
    });
    return () => controller.abort();
  }, [client]);

  const oldestEventSeq = events[0]?.seq;

  async function loadMoreEvents() {
    const before = oldestEventSeq;
    if (!before || loadingMore || !hasMoreEvents) return;
    setLoadingMore(true);
    try {
      const page = await client.listRoomEvents({
        beforeEventSeq: before,
        limit: EVENT_PAGE_SIZE,
      });
      setEvents((current) => mergeEvents(page.events, current));
      setHasMoreEvents(page.hasMore);
    } catch (cause) {
      setConnection(cause instanceof Error ? cause.message : "could not load activity");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const root = activityRef.current;
    const target = loadMoreRef.current;
    if (!root || !target || loadingMore || !hasMoreEvents) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void loadMoreEvents();
    }, { root, rootMargin: "0px 0px 120px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [oldestEventSeq, hasMoreEvents, loadingMore]);

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
          <h1>{room?.capacity || "—"} agents. One table.</h1>
        </div>
        <div className="header-actions">
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
          {hasMoreEvents && (
            <li aria-live="polite" className="load-more-row" ref={loadMoreRef}>
              {loadingMore ? "Loading earlier activity…" : ""}
            </li>
          )}
        </ol>
      </section>
    </main>
  );
}

function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void client.getLeaderboard({}, { signal: controller.signal })
      .then((response) => setEntries(response.entries))
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load scores");
      });
    return () => controller.abort();
  }, []);

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AGENT POKER · LIFETIME POINTS</p>
          <h1>Leaderboard</h1>
        </div>
        <a className="page-link" href="/">← Live table</a>
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

function streetName(street?: Street): string {
  return street === undefined || street === Street.UNSPECIFIED ? "—" : Street[street];
}

function tableMessage(room?: RoomSnapshot): string {
  if (room?.paused) return "Room paused for maintenance";
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

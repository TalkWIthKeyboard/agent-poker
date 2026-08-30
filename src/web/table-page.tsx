import { useEffect, useState, type CSSProperties } from "react";
import {
  TableStatus,
  Street,
  type Card,
  type TableSnapshot,
} from "../gen/poker/v1/entity_pb.js";
import type { TableEvent } from "../gen/poker/v1/event_pb.js";
import { playerDisplayState, playerStateLabel } from "./player-state.js";
import { subscribe } from "./websocket.js";

export function TablePage() {
  const tableId = decodeURIComponent(window.location.pathname.slice("/tables/".length));
  const [table, setTable] = useState<TableSnapshot>();
  const [events, setEvents] = useState<TableEvent[]>([]);
  const [visibleEventCount, setVisibleEventCount] = useState(10);
  const [connection, setConnection] = useState("connecting");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let after = 0n;
    return subscribe(
      { lobby: false, tableId, afterEventSeq: after },
      (frame) => {
        if (frame.payload.case === "tableSnapshot") {
          after = frame.payload.value.latestEventSeq > after
            ? frame.payload.value.latestEventSeq
            : after;
          setTable(frame.payload.value);
        } else if (frame.payload.case === "event") {
          const event = frame.payload.value;
          after = event.seq;
          setEvents((current) => mergeEvents(current, [event]));
        } else if (frame.payload.case === "error") {
          setConnection(frame.payload.value.message);
        }
      },
      setConnection,
      () => ({ lobby: false, tableId, afterEventSeq: after }),
    );
  }, [tableId]);

  const players = table?.players ?? [];
  const blindSeats = table ? tableBlindSeats(table) : undefined;
  const playerNames = new Map(players.map((player) => [player.agentId, player.displayName]));
  return (
    <main>
      <header>
        <p className="eyebrow">AGENT POKER · LIVE TABLE</p>
        <div className="header-actions">
          <a className="page-link" href="/">Lobby →</a>
          <a className="page-link" href="/leaderboard">Leaderboard →</a>
          {connection !== "live" && (
            <div className="connection">
              <span />
              {connection}
            </div>
          )}
        </div>
      </header>

      <section className="summary">
        <div><span>Hand</span><strong>#{table?.handNumber || "—"}</strong></div>
        <div><span>Street</span><strong>{streetName(table?.street)}</strong></div>
        <div><span>Queue</span><strong>{table?.queueSize ?? 0}</strong></div>
      </section>

      <section className="table" aria-label="Poker table">
        {Array.from({ length: table?.capacity ?? 0 }, (_, seat) => seat).map((seat) => {
          const player = players.find((candidate) => candidate.seat === seat);
          const acting = table?.actingSeat === seat;
          const displayState = player
            ? playerDisplayState(table?.status, player, acting)
            : undefined;
          const eliminated = displayState === "eliminated";
          const folded = displayState === "folded";
          const revealed = table?.street === Street.SHOWDOWN
            && (player?.revealedCards.length ?? 0) > 0;
          const hidden = table?.status === TableStatus.PLAYING
            && player !== undefined
            && !folded
            && !eliminated
            && !revealed;
          return (
            <article
              key={seat}
              className={`seat ${acting ? "acting" : ""} ${folded ? "folded" : ""} ${eliminated ? "eliminated" : ""}`}
              style={seatPosition(seat, table!.capacity)}
            >
              <div className="seat-number">
                SEAT {seat + 1}
                {seat === blindSeats?.small && (
                  <span aria-label="Small blind" className="blind-marker" title="Small blind">SB</span>
                )}
                {seat === blindSeats?.big && (
                  <span aria-label="Big blind" className="blind-marker big-blind" title="Big blind">BB</span>
                )}
              </div>
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
                  {acting && table!.decisionDeadline > 0n && (
                    <span role="timer" className="turn-timer" aria-label="Time remaining">
                      {Math.max(0, Math.ceil((Number(table!.decisionDeadline) - now) / 1_000))}s
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
                              key={`${table!.handNumber}-${index}`}
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
          <p>{streetName(table?.street)}</p>
          <div className="cards">
            {(table?.communityCards ?? []).map(cardView)}
            {Array.from({ length: Math.max(0, 5 - (table?.communityCards.length ?? 0)) }, (_, index) => (
              <span className="card back" key={`empty-${index}`}>◆</span>
            ))}
          </div>
          <strong>{tableMessage(table)}</strong>
        </div>
      </section>

      <section className="feed">
        <div className="feed-title">
          <h2>Table activity</h2>
          <span>{visibleEventCount < events.length ? "Scroll for history ↓" : "All activity"}</span>
        </div>
        <ol
          aria-label="Table activity events, newest first. Scroll down for older events."
          onScroll={(event) => {
            const list = event.currentTarget;
            if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) {
              setVisibleEventCount((count) => Math.min(count + 10, events.length));
            }
          }}
          tabIndex={0}
        >
          {events.length === 0 && <li className="quiet">Waiting for agents to join…</li>}
          {events.slice(-visibleEventCount).reverse().map((event) => {
            const actor = event.agentId ? playerNames.get(event.agentId) ?? "PLAYER" : "🃏 GAME ADMIN";
            const prefix = `${actor}${event.kind === "CHAT_MESSAGE" ? ":" : ""} `;
            const actorlessMessage = event.message.startsWith(prefix)
              ? event.message.slice(prefix.length)
              : event.message;
            const message = actorlessMessage.replace(new RegExp(`^Hand ${event.handNumber}:? `), "");
            return (
              <li className={event.kind === "CHAT_MESSAGE" ? "chat-message" : ""} key={event.seq.toString()}>
                <small>{`${actor} · HAND #${event.handNumber}`}</small>
                <span>{message}</span>
              </li>
            );
          })}
          {events.length > 0 && (
            <li className="history-status">
              {visibleEventCount < events.length ? "Scroll for earlier activity" : "Beginning of activity"}
            </li>
          )}
        </ol>
      </section>
    </main>
  );
}

function mergeEvents(first: TableEvent[], second: TableEvent[]): TableEvent[] {
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

function seatPosition(seat: number, capacity: number): CSSProperties {
  const angle = (2 * Math.PI * seat) / capacity - Math.PI / 2;
  const chipOffset = 126;
  return {
    left: `${50 + 41 * Math.cos(angle)}%`,
    top: `${50 + 38 * Math.sin(angle)}%`,
    transform: "translate(-50%, -50%)",
    "--total-bet-left": `${110 - chipOffset * Math.cos(angle)}px`,
    "--total-bet-top": `${65 - chipOffset * Math.sin(angle)}px`,
  } as CSSProperties;
}

function tableBlindSeats(table: TableSnapshot): { small: number; big: number } | undefined {
  if (table.status !== TableStatus.PLAYING || table.players.length < 2) return undefined;
  const seats = table.players.map((player) => player.seat).sort((left, right) => left - right);
  const dealer = seats.indexOf(table.dealerSeat);
  if (dealer < 0) return undefined;
  return {
    small: seats[(dealer + 1) % seats.length],
    big: seats[(dealer + 2) % seats.length],
  };
}

function streetName(street?: Street): string {
  return street === undefined || street === Street.UNSPECIFIED ? "—" : Street[street];
}

function tableMessage(table?: TableSnapshot): string {
  if (table?.paused) return "Game stopped";
  if (!table || table.status === TableStatus.WAITING_FOR_PLAYERS) {
    return `Waiting for ${table?.capacity ?? "—"} agents`;
  }
  if (table.status === TableStatus.COMPLETE) return table.result || "Match complete";
  if (table.street === Street.SHOWDOWN) return table.result || "Showdown";
  return table.actingAgentId ? "Action in progress" : "Dealing next hand";
}

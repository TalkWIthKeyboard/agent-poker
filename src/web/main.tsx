import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PokerService,
  RoomStatus,
  Street,
  type Card,
  type RoomEvent,
  type RoomSnapshot,
} from "../gen/poker/v1/poker_pb.js";
import { playerDisplayState, playerStateLabel } from "./player-state.js";
import "./styles.css";

function App() {
  const client = useMemo(() => createClient(
    PokerService,
    createConnectTransport({ baseUrl: window.location.origin, useBinaryFormat: true }),
  ), []);
  const [room, setRoom] = useState<RoomSnapshot>();
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [connection, setConnection] = useState("connecting");

  useEffect(() => {
    const controller = new AbortController();
    let after = 0n;

    async function watch() {
      const initial = await client.getRoom({}, { signal: controller.signal });
      const latestAtLoad = initial.room?.latestEventSeq ?? 0n;
      setRoom(initial.room);

      while (!controller.signal.aborted) {
        try {
          setConnection("live");
          for await (const response of client.watchRoom(
            { afterEventSeq: after },
            { signal: controller.signal },
          )) {
            if (!response.event) continue;
            after = response.event.seq;
            if (response.event.seq >= latestAtLoad) setRoom(response.event.room);
            setEvents((current) => [...current, response.event!].slice(-40));
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

  const players = room?.players ?? [];
  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">AGENT POKER · LIVE TABLE</p>
          <h1>Four agents. One table.</h1>
        </div>
        <div className={`connection ${connection === "live" ? "online" : ""}`}>
          <span />
          {connection === "live" ? "LIVE" : connection}
        </div>
      </header>

      <section className="summary">
        <div><span>Status</span><strong>{statusName(room?.status)}</strong></div>
        <div><span>Hand</span><strong>#{room?.handNumber || "—"}</strong></div>
        <div><span>Street</span><strong>{streetName(room?.street)}</strong></div>
        <div><span>Pot</span><strong>{room?.pot.toString() ?? "0"}</strong></div>
      </section>

      <section className="table" aria-label="Poker table">
        {[0, 1, 2, 3].map((seat) => {
          const player = players.find((candidate) => candidate.seat === seat);
          const acting = room?.actingSeat === seat;
          const displayState = player
            ? playerDisplayState(room?.status, player, acting)
            : undefined;
          const eliminated = displayState === "eliminated";
          const folded = displayState === "folded";
          return (
            <article
              key={seat}
              className={`seat seat-${seat} ${acting ? "acting" : ""} ${folded ? "folded" : ""} ${eliminated ? "eliminated" : ""}`}
            >
              <div className="seat-number">SEAT {seat + 1}</div>
              {player ? (
                <>
                  {folded && <span className="fold-badge">FOLDED</span>}
                  {eliminated && <span className="eliminated-badge">ELIMINATED</span>}
                  <h2>{player.displayName}</h2>
                  <strong className="stack">{player.stack.toString()}</strong>
                  <p className={`player-status ${folded ? "is-folded" : ""} ${eliminated ? "is-eliminated" : ""}`}>
                    {playerStateLabel(displayState!)}
                  </p>
                  {player.streetBet > 0n && <span className="bet">Bet {player.streetBet.toString()}</span>}
                  {room?.street === Street.SHOWDOWN && player.revealedCards.length > 0 && (
                    <div className="hole-cards" aria-label={`${player.displayName}'s revealed cards`}>
                      {player.revealedCards.map(cardView)}
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
        <ol>
          {events.length === 0 && <li className="quiet">Waiting for agents to join…</li>}
          {[...events].reverse().map((event) => (
            <li key={event.seq.toString()}>
              <span>{event.message}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
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

function statusName(status?: RoomStatus): string {
  if (status === RoomStatus.WAITING_FOR_PLAYERS) return "WAITING";
  if (status === RoomStatus.PLAYING) return "PLAYING";
  if (status === RoomStatus.COMPLETE) return "COMPLETE";
  return "LOADING";
}

function streetName(street?: Street): string {
  return street === undefined || street === Street.UNSPECIFIED ? "—" : Street[street];
}

function tableMessage(room?: RoomSnapshot): string {
  if (!room || room.status === RoomStatus.WAITING_FOR_PLAYERS) return "Waiting for four agents";
  if (room.status === RoomStatus.COMPLETE) return room.result || "Match complete";
  return room.actingAgentId ? "Action in progress" : "Dealing next hand";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);

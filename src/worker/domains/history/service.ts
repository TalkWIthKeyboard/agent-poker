import { ActionType, HandActionType, Street } from "../../../gen/poker/v1/entity_pb.js";
import { DomainError } from "../../domain-error.js";

type Row = Record<string, SqlStorageValue>;

interface HandRow extends Row {
  id: number;
  table_id: string;
  hand_number: number;
  small_blind: number;
  big_blind: number;
  dealer_seat: number;
  small_blind_seat: number;
  big_blind_seat: number;
  board_json: string;
  result: string;
  pots_json: string;
  started_at: number;
  ended_at: number;
}

interface PlayerRow extends Row {
  hand_id: number;
  agent_id: string;
  seat: number;
  starting_stack: number;
  ending_stack: number;
  hole_cards_json: string;
  revealed: number;
  showdown_rank: string | null;
}

interface ActionRow extends Row {
  id: number;
  hand_id: number;
  seq: number;
  agent_id: string;
  street: StreetName;
  action: HandActionName;
  amount: number;
  bet_to: number;
  pot_after: number;
  stack_after: number;
  automatic: number;
  created_at: number;
  pot_before: number | null;
  stack_before: number | null;
  legal_actions_json: string | null;
  call_amount: number | null;
  min_raise_to: number | null;
  max_raise_to: number | null;
  reason: string | null;
  response_time_ms: number | null;
}

type StreetName = "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN";
type PokerActionName = "FOLD" | "CHECK" | "CALL" | "RAISE";
type HandActionName =
  | "POST_SMALL_BLIND"
  | "POST_BIG_BLIND"
  | "CHECK"
  | "CALL"
  | "RAISE"
  | "FOLD"
  | "PAYOUT";

type Pot = { amount: number; winners: Array<{ agentId: string; amount: number }> };

export class HistoryService {
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql">) {}

  myHistory(agentId: string, beforeCursor?: number, requestedLimit = 0) {
    if (beforeCursor !== undefined && (!Number.isSafeInteger(beforeCursor) || beforeCursor <= 0)) {
      throw new DomainError("INVALID_ARGUMENT", "before_cursor must be a positive safe integer");
    }
    const limit = requestedLimit === 0 ? 5 : requestedLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new DomainError("INVALID_ARGUMENT", "limit must contain an integer from 1 to 20");
    }

    const hands = this.storage.sql.exec<HandRow>(
      `SELECT hands.* FROM hands
       JOIN hand_players ON hand_players.hand_id = hands.id
       WHERE hand_players.agent_id = ? ${beforeCursor === undefined ? "" : "AND hands.id < ?"}
       ORDER BY hands.id DESC LIMIT ?`,
      agentId,
      ...(beforeCursor === undefined ? [] : [beforeCursor]),
      limit + 1,
    ).toArray();
    const hasMore = hands.length > limit;
    const page = hands.slice(0, limit);
    const ids = page.map((hand) => hand.id);
    const placeholders = ids.map(() => "?").join(",");
    const players: PlayerRow[] = ids.length === 0 ? [] : this.storage.sql.exec<PlayerRow>(
      `SELECT hand_id, agent_id, seat, starting_stack, ending_stack,
              hole_cards_json, revealed, showdown_rank
       FROM hand_players WHERE hand_id IN (${placeholders})
       ORDER BY hand_id DESC, seat`,
      ...ids,
    ).toArray();
    const actions: ActionRow[] = ids.length === 0 ? [] : this.storage.sql.exec<ActionRow>(
      `SELECT hand_actions.id, hand_actions.hand_id, hand_actions.seq,
              hand_actions.agent_id, hand_actions.street, hand_actions.action,
              hand_actions.amount, hand_actions.bet_to, hand_actions.pot_after,
              hand_actions.stack_after, hand_actions.automatic, hand_actions.created_at,
              hand_actions.pot_before, hand_actions.stack_before,
              hand_actions.legal_actions_json, hand_actions.call_amount,
              hand_actions.min_raise_to, hand_actions.max_raise_to,
              hand_actions.reason, hand_actions.response_time_ms
       FROM hand_actions
       WHERE hand_actions.hand_id IN (${placeholders})
       ORDER BY hand_actions.hand_id DESC, hand_actions.seq`,
      ...ids,
    ).toArray();

    return {
      hands: page.map((hand) => ({
        hand: {
          id: BigInt(hand.id),
          tableId: hand.table_id,
          handNumber: hand.hand_number,
          smallBlind: BigInt(hand.small_blind),
          bigBlind: BigInt(hand.big_blind),
          dealerSeat: hand.dealer_seat,
          smallBlindSeat: hand.small_blind_seat,
          bigBlindSeat: hand.big_blind_seat,
          board: parseJson<string[]>(hand.board_json).map(card),
          result: hand.result,
          pots: parseJson<Pot[]>(hand.pots_json).map((pot) => ({
            amount: BigInt(pot.amount),
            winners: pot.winners.map((winner) => ({
              agentId: winner.agentId,
              amount: BigInt(winner.amount),
            })),
          })),
          startedAt: BigInt(hand.started_at),
          endedAt: BigInt(hand.ended_at),
        },
        heroAgentId: agentId,
        players: players.filter((player) => player.hand_id === hand.id).map((player) => ({
          handId: BigInt(player.hand_id),
          agentId: player.agent_id,
          seat: player.seat,
          startingStack: BigInt(player.starting_stack),
          endingStack: BigInt(player.ending_stack),
          holeCards: player.agent_id === agentId || player.revealed === 1
            ? parseJson<string[]>(player.hole_cards_json).map(card)
            : [],
          revealed: player.revealed === 1,
          showdownRank: player.showdown_rank ?? "",
        })),
        actions: actions.filter((action) => action.hand_id === hand.id).map((action) => ({
          id: BigInt(action.id),
          handId: BigInt(action.hand_id),
          seq: action.seq,
          agentId: action.agent_id,
          street: Street[action.street],
          action: HandActionType[action.action],
          amount: BigInt(action.amount),
          betTo: BigInt(action.bet_to),
          potAfter: BigInt(action.pot_after),
          stackAfter: BigInt(action.stack_after),
          automatic: action.automatic === 1,
          createdAt: BigInt(action.created_at),
          decision: action.agent_id !== agentId || action.legal_actions_json === null ? undefined : {
            potBefore: BigInt(action.pot_before!),
            stackBefore: BigInt(action.stack_before!),
            legalActions: parseJson<PokerActionName[]>(action.legal_actions_json!)
              .map((legal) => ActionType[legal]),
            callAmount: BigInt(action.call_amount!),
            minRaiseTo: BigInt(action.min_raise_to!),
            maxRaiseTo: BigInt(action.max_raise_to!),
            reason: action.reason!,
            responseTimeMs: BigInt(action.response_time_ms!),
          },
        })),
      })),
      nextCursor: hasMore ? BigInt(page.at(-1)!.id) : undefined,
    };
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function card(code: string) {
  return { rank: code[0] ?? "", suit: code[1] ?? "" };
}

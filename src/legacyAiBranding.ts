import { singlePlayerAiNames } from './game';
import type { GameState } from './types';

export const legacySinglePlayerAiNames = [
  'Picard', 'Riker', 'Data', 'Worf', 'Geordi', 'Beverly', 'Troi', 'Sisko', 'Kira', 'Dax',
  'Odo', 'Quark', 'Janeway', 'Seven', 'Tuvok', 'Kirk', 'Spock', 'Uhura', 'Sulu', 'Scotty',
  'Bones', 'Pike', 'Saru', 'Burnham', 'Mariner', 'Boimler', 'Adama', 'Roslin', 'Starbuck', 'Apollo',
  'Boomer', 'Athena', 'Helo', 'Tyrol', 'Tigh', 'Baltar', 'Six', 'Anders', 'Gaeta', 'Dualla',
  'TChalla', 'Shuri', 'Okoye', 'Wanda', 'Vision', 'Natasha', 'Clint', 'Thor', 'Loki', 'Valkyrie',
  'Carol', 'Monica', 'Kamala', 'Strange', 'Wong', 'Peter', 'Miles', 'Gwen', 'Logan', 'Ororo',
  'Rogue', 'Gambit', 'Jean', 'Scott', 'Hank', 'Doom', 'Reed', 'Sue', 'Ben', 'Johnny',
  'Ripley', 'Hicks', 'Vasquez', 'Sarah', 'Neo', 'Trinity', 'Morpheus', 'Luke', 'Leia', 'Han',
  'Chewie', 'Lando', 'Rey', 'Finn', 'Poe', 'Ahsoka', 'Grogu'
] as const;

const legacyAiNameMap = new Map<string, string>(
  legacySinglePlayerAiNames.map((name, index) => [name, singlePlayerAiNames[index]])
);

export const legacyAiMigrationLog = 'Earlier game activity was cleared during a Flipvale update.';

/**
 * Rename only roster entries explicitly marked as AI. Round history follows
 * player IDs, while free-form logs are reset so a human who happens to use a
 * legacy bot name is never rewritten.
 */
export function sanitizeLegacySoloAiNames(state: GameState): GameState {
  const migratedNamesByPlayerId = new Map<string, string>();
  const players = state.players.map((player) => {
    if (player.kind !== 'ai') return player;
    const replacement = legacyAiNameMap.get(player.name);
    if (!replacement) return player;
    migratedNamesByPlayerId.set(player.id, replacement);
    return { ...player, name: replacement };
  });
  if (migratedNamesByPlayerId.size === 0) return state;

  return {
    ...state,
    players,
    log: [legacyAiMigrationLog],
    roundHistory: state.roundHistory.map((round) => ({
      ...round,
      scores: round.scores.map((score) => {
        const replacement = migratedNamesByPlayerId.get(score.playerId);
        return replacement ? { ...score, name: replacement } : score;
      })
    }))
  };
}

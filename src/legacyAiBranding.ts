import { singlePlayerAiNames } from './game';
import type { GameState } from './types';

export const legacySinglePlayerAiNameHashes = [
  '5542973044ba0c68', '9f3f85ba04cab13e', 'ac8256732f2ee1e5', '9ae6fc0237d8afb7',
  'afe3eb7f06cf202f', '3d1dff043d987346', '85c8a1fb52a15ab7', 'ee6fd5b540765848',
  '708692de3ab5ed90', 'e0955819920ee6ca', '3033b419bfa02a13', 'a35ecc75e1a63dfd',
  '15db540c53723910', 'bd8e8196e922467e', '62e31137432d1fe6', '70869cde3ab5fe8e',
  '154c2df12edb39b9', '6904e684cbab83aa', 'e1658725233e340a', '0d9a4e19fcf1b81f',
  '0da6d11908db12b4', 'e9b4f319c69b459a', '33ea3f24c0e97c4c', 'fe743368a6c0860a',
  'eca47f02d4f81b4f', 'c1ceaac0cbbd4ddb', 'cf48420e2ba85239', 'c5dbafcaae518a32',
  '28e6cdf4c16ed09a', '301648985132870a', '3390f194f1a39efd', 'e2a54c4261f312e6',
  '3526fcd86112ad53', '691448561268b617', '48f69ffb3020dae9', 'dbe59b5dddf6662f',
  '9851ab19faa5abab', '0a1e4ea743727ac6', '9d5332236a829907', '8abe8498a5d71df8',
  'ac92af320d252ece', '804555af4a634330', '1600c52150714b7a', '731109b3731b49da',
  '2b8dbccdfbf285e9', '61ab1a3103018ff7', '4c22effb7b224ea3', '5029bcfb33ca5378',
  '4f0cd4b48a51b444', '2e5103b33e776a7c', '6f7c78a17ba65ed2', '032fcd9a5f580400',
  'dd93da2166f81088', '2ea5e82b669fcb6f', '9b0efb0237fa0018', 'f94473ead8b40629',
  '5379e9c93462a981', '0c07397e36b12774', 'c8bf5cc71dcfa6da', '89d3bad928c50762',
  'a8f220a7ceb30d8d', '39136f7053bec6e3', '9e96e9ea46bb8fdf', '7d5436625717819c',
  '58baa4d8757c813d', '037cf073608cdae4', '741b642bbe75c671', '987ab619fac8c370',
  '16343819b0e5e58a', 'b21b5d1c8513a7dd', '1c971033afe65892', 'e1e93f121e054f19',
  'f61e3f1a2d42578c', '20ae8773cce11f08', '3741fd19c32ad129', '657f87cad620172c',
  '4e907860b881b794', '2f5bf6b5091cc732', 'a5a48eb4bb5b6648', '49612e19cda89924',
  '54ad30f3544c5a6c', 'ecdd0cf7a8a06409', '9ff1d319feac08cb', 'd1fe1b84eebc2ffc',
  '8da36d19f40675ff', 'bbc49fd5115096a2', '9881dc8fb600030d'
] as const;

const legacyAiNameMap = new Map<string, string>(
  legacySinglePlayerAiNameHashes.map((hash, index) => [hash, singlePlayerAiNames[index]])
);

export function legacyAiNameHash(name: string): string | null {
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < name.length; index += 1) {
    const byte = name.charCodeAt(index);
    if (byte > 0x7f) return null;
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, '0');
}

function replacementForLegacyAiName(name: string): string | undefined {
  const hash = legacyAiNameHash(name);
  return hash ? legacyAiNameMap.get(hash) : undefined;
}

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
    const replacement = replacementForLegacyAiName(player.name);
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

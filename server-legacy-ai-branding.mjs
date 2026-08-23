export const currentSinglePlayerAiNames = [
  'Acorn', 'Alder', 'Aster', 'Aspen', 'Birch', 'Bramble', 'Breeze', 'Brook', 'Canyon', 'Cedar',
  'Clover', 'Coral', 'Cove', 'Cypress', 'Dahlia', 'Dawn', 'Dune', 'Echo', 'Elm', 'Ember',
  'Fawn', 'Fern', 'Finch', 'Fjord', 'Flint', 'Forest', 'Gale', 'Garnet', 'Glade', 'Harbor',
  'Hazel', 'Heather', 'Indigo', 'Ivy', 'Jade', 'Juniper', 'Kestrel', 'Lake', 'Lark', 'Laurel',
  'Linden', 'Lotus', 'Maple', 'Marigold', 'Meadow', 'Mica', 'Mist', 'Moss', 'Moon', 'Olive',
  'Onyx', 'Opal', 'Orchid', 'Pebble', 'Pine', 'Poppy', 'Prairie', 'Quartz', 'Rain', 'Reef',
  'Ridge', 'River', 'Robin', 'Rowan', 'Ruby', 'Sage', 'Saffron', 'Sequoia', 'Sky', 'Slate',
  'Sol', 'Sparrow', 'Spruce', 'Starling', 'Stone', 'Storm', 'Summit', 'Sunny', 'Terra', 'Thistle',
  'Tide', 'Topaz', 'Vale', 'Violet', 'Willow', 'Wren', 'Zephyr'
];

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
];

export const legacyAiNameMap = new Map(
  legacySinglePlayerAiNames.map((name, index) => [name, currentSinglePlayerAiNames[index]])
);

export const legacyAiMigrationLog = 'Earlier game activity was cleared during a Flipvale update.';

export function sanitizeLegacySoloAiNames(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.players)) return state;
  const migratedNamesByPlayerId = new Map();
  const players = state.players.map((player) => {
    if (!player || player.kind !== 'ai') return player;
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
    roundHistory: Array.isArray(state.roundHistory)
      ? state.roundHistory.map((round) => ({
          ...round,
          scores: Array.isArray(round?.scores)
            ? round.scores.map((score) => {
                const replacement = migratedNamesByPlayerId.get(score?.playerId);
                return replacement ? { ...score, name: replacement } : score;
              })
            : round?.scores
        }))
      : state.roundHistory
  };
}

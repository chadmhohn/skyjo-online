import { singlePlayerAiNames } from '../../../src/game';
import {
  legacyAiNameHash as browserHash,
  legacySinglePlayerAiNameHashes as browserLegacyHashes
} from '../../../src/legacyAiBranding';
import {
  currentSinglePlayerAiNames as serverCurrentNames,
  legacyAiNameHash as serverHash,
  legacySinglePlayerAiNameHashes as serverLegacyHashes
} from '../../../server-legacy-ai-branding.mjs';

const legacyNames = [
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

describe('legacy AI branding parity', () => {
  it('keeps browser and server position-based migrations identical', () => {
    expect(serverLegacyHashes).toEqual([...browserLegacyHashes]);
    expect(serverCurrentNames).toEqual([...singlePlayerAiNames]);
    expect(legacyNames.map(browserHash)).toEqual([...browserLegacyHashes]);
    expect(legacyNames.map(serverHash)).toEqual([...serverLegacyHashes]);
    expect(new Set(serverLegacyHashes).size).toBe(serverLegacyHashes.length);
    expect(serverLegacyHashes).toHaveLength(serverCurrentNames.length);
    expect(browserHash('Zephyr 🌲')).toBeNull();
    expect(serverHash('Zephyr 🌲')).toBeNull();
  });
});

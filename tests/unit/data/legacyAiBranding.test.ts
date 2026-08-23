import { singlePlayerAiNames } from '../../../src/game';
import { legacySinglePlayerAiNames as browserLegacyNames } from '../../../src/legacyAiBranding';
import {
  currentSinglePlayerAiNames as serverCurrentNames,
  legacySinglePlayerAiNames as serverLegacyNames
} from '../../../server-legacy-ai-branding.mjs';

describe('legacy AI branding parity', () => {
  it('keeps browser and server position-based migrations identical', () => {
    expect(serverLegacyNames).toEqual([...browserLegacyNames]);
    expect(serverCurrentNames).toEqual([...singlePlayerAiNames]);
    expect(new Set(serverLegacyNames).size).toBe(serverLegacyNames.length);
    expect(serverLegacyNames).toHaveLength(serverCurrentNames.length);
  });
});

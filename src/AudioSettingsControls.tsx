import { playAudioTestCue, primeAudio, useAudioSettings } from './audio';

export default function AudioSettingsControls() {
  const [settings, setSettings, audioStatus] = useAudioSettings();
  const audioStatusMessage =
    audioStatus === 'ready'
      ? 'Audio is ready.'
      : audioStatus === 'blocked'
        ? 'Audio is blocked. Tap Preview sounds or interact with the page to unlock it.'
        : audioStatus === 'unavailable'
          ? 'This browser cannot play audio assets.'
          : 'Tap Preview sounds to enable audio.';

  function updateVolume(value: string) {
    setSettings({ soundVolume: Number(value) / 100 });
  }

  return (
    <div className="skyjo-audio-controls" onPointerDown={() => void primeAudio()}>
      <div className="skyjo-audio-settings-grid">
        <label className="skyjo-audio-setting-row">
          <span>
            <span className="skyjo-audio-setting-title">Game sounds</span>
            <span className="block text-xs font-bold text-[#f5e6c8]/50">Cards, turns, and scoring</span>
          </span>
          <input
            checked={settings.soundEffects}
            className="skyjo-audio-toggle"
            onChange={(event) => setSettings({ soundEffects: event.target.checked })}
            type="checkbox"
          />
        </label>
        <label className="skyjo-audio-setting-slider">
          <span>Game volume</span>
          <input
            className="skyjo-audio-range"
            disabled={!settings.soundEffects}
            max="100"
            min="0"
            onChange={(event) => updateVolume(event.target.value)}
            type="range"
            value={Math.round(settings.soundVolume * 100)}
          />
        </label>
      </div>
      <button
        className="skyjo-button skyjo-audio-test-button px-3 py-2 text-sm"
        disabled={!settings.soundEffects}
        onClick={() => void playAudioTestCue()}
        onPointerDown={() => void primeAudio()}
        type="button"
      >
        Preview sounds
      </button>
      <p className="skyjo-audio-status text-xs font-bold leading-5 text-[#f5e6c8]/58">{audioStatusMessage}</p>
    </div>
  );
}

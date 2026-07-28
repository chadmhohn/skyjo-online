import Foundation
import Observation

@MainActor
@Observable
final class SoloPreferencesStore {
  private enum Key {
    static let accessWasConfirmed = "native.access.was-confirmed"
    static let lastConfirmedAccountID = "native.solo.last-confirmed-account-id"
    static let soundEffectsEnabled = "native.settings.sound-effects-enabled"
    static let musicEnabled = "native.settings.music-enabled"
    static let hapticsEnabled = "native.settings.haptics-enabled"
  }

  @ObservationIgnored private let defaults: UserDefaults

  var accessWasConfirmed: Bool {
    didSet { defaults.set(accessWasConfirmed, forKey: Key.accessWasConfirmed) }
  }

  var lastConfirmedAccountID: UUID? {
    didSet {
      defaults.set(
        lastConfirmedAccountID?.uuidString.lowercased(),
        forKey: Key.lastConfirmedAccountID
      )
    }
  }

  var soundEffectsEnabled: Bool {
    didSet { defaults.set(soundEffectsEnabled, forKey: Key.soundEffectsEnabled) }
  }

  private(set) var musicEnabled: Bool

  var hapticsEnabled: Bool {
    didSet { defaults.set(hapticsEnabled, forKey: Key.hapticsEnabled) }
  }

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    accessWasConfirmed = defaults.bool(forKey: Key.accessWasConfirmed)
    if let storedID = defaults.string(forKey: Key.lastConfirmedAccountID),
       storedID == UUID(uuidString: storedID)?.uuidString.lowercased()
    {
      lastConfirmedAccountID = UUID(uuidString: storedID)
    } else {
      lastConfirmedAccountID = nil
    }
    soundEffectsEnabled = defaults.object(forKey: Key.soundEffectsEnabled) == nil
      ? true
      : defaults.bool(forKey: Key.soundEffectsEnabled)
    // No approved music asset is bundled in IOS-7. Preserve an explicit off default and sanitize
    // stale/local values until a licensed asset is approved.
    musicEnabled = false
    defaults.set(false, forKey: Key.musicEnabled)
    hapticsEnabled = defaults.object(forKey: Key.hapticsEnabled) == nil
      ? true
      : defaults.bool(forKey: Key.hapticsEnabled)
  }

  func confirmAccess() {
    accessWasConfirmed = true
  }

  func clearConfirmedAccessAndAccount() {
    accessWasConfirmed = false
    lastConfirmedAccountID = nil
  }

  func confirmAccount(_ accountID: UUID) {
    lastConfirmedAccountID = accountID
  }

  func confirmSignedOut() {
    lastConfirmedAccountID = nil
  }
}

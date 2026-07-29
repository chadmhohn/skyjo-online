import AVFAudio
import Foundation
import UIKit

enum GameFeedbackEvent: String, Sendable {
  case flip
  case pickup
  case place
  case columnClear
  case localTurn
  case roundEnd
  case gameEnd
}

@MainActor
final class GameFeedbackController {
  private let preferences: SoloPreferencesStore
  private var players: [String: AVAudioPlayer] = [:]
  private var deliveredKeys: Set<String> = []
  private var orderedKeys: [String] = []
  private var isActive = true

  init(preferences: SoloPreferencesStore) {
    self.preferences = preferences
    configureAudioSession()
  }

  func setSceneActive(_ active: Bool) {
    isActive = active
    if !active {
      players.values.forEach { $0.stop() }
    }
  }

  func baseline(gameID: UUID, saveSequence: Int64) {
    remember(key: "\(gameID.uuidString.lowercased()):\(saveSequence):baseline")
  }

  func emit(_ event: GameFeedbackEvent, gameID: UUID, saveSequence: Int64) {
    let key = "\(gameID.uuidString.lowercased()):\(saveSequence):\(event.rawValue)"
    guard isActive, !deliveredKeys.contains(key) else { return }
    remember(key: key)

    if preferences.soundEffectsEnabled {
      playSound(for: event)
    }
    if preferences.hapticsEnabled {
      playHaptic(for: event)
    }
  }

  private func remember(key: String) {
    guard deliveredKeys.insert(key).inserted else { return }
    orderedKeys.append(key)
    if orderedKeys.count > 256 {
      let overflow = orderedKeys.count - 256
      let removed = Array(orderedKeys.prefix(overflow))
      orderedKeys.removeFirst(overflow)
      deliveredKeys.subtract(removed)
    }
  }

  private func configureAudioSession() {
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
      try session.setActive(true)
    } catch {
      // Audio is optional feedback. Gameplay remains fully operable without it.
    }
  }

  private func playSound(for event: GameFeedbackEvent) {
    let resource: String
    switch event {
    case .flip, .columnClear:
      resource = "card-flip"
    case .pickup, .localTurn:
      resource = "card-pickup"
    case .place, .roundEnd, .gameEnd:
      resource = "card-place"
    }
    guard let url = Bundle.main.url(forResource: resource, withExtension: "mp3") else { return }
    do {
      let player = try AVAudioPlayer(contentsOf: url)
      player.prepareToPlay()
      players[resource] = player
      player.play()
    } catch {
      // Optional feedback must never block a legal move.
    }
  }

  private func playHaptic(for event: GameFeedbackEvent) {
    switch event {
    case .flip, .pickup, .place, .localTurn:
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    case .columnClear:
      UINotificationFeedbackGenerator().notificationOccurred(.success)
    case .roundEnd:
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    case .gameEnd:
      UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
  }
}

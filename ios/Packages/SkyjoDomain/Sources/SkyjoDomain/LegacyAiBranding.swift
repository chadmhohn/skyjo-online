import Foundation

public enum LegacyAiBranding {
  public static let legacySinglePlayerAINames = [
    "Picard", "Riker", "Data", "Worf", "Geordi", "Beverly", "Troi", "Sisko", "Kira", "Dax",
    "Odo", "Quark", "Janeway", "Seven", "Tuvok", "Kirk", "Spock", "Uhura", "Sulu", "Scotty",
    "Bones", "Pike", "Saru", "Burnham", "Mariner", "Boimler", "Adama", "Roslin", "Starbuck", "Apollo",
    "Boomer", "Athena", "Helo", "Tyrol", "Tigh", "Baltar", "Six", "Anders", "Gaeta", "Dualla",
    "TChalla", "Shuri", "Okoye", "Wanda", "Vision", "Natasha", "Clint", "Thor", "Loki", "Valkyrie",
    "Carol", "Monica", "Kamala", "Strange", "Wong", "Peter", "Miles", "Gwen", "Logan", "Ororo",
    "Rogue", "Gambit", "Jean", "Scott", "Hank", "Doom", "Reed", "Sue", "Ben", "Johnny",
    "Ripley", "Hicks", "Vasquez", "Sarah", "Neo", "Trinity", "Morpheus", "Luke", "Leia", "Han",
    "Chewie", "Lando", "Rey", "Finn", "Poe", "Ahsoka", "Grogu",
  ]

  public static let migrationLog = "Earlier game activity was cleared during a Flipvale update."

  private static let nameMap = Dictionary(
    uniqueKeysWithValues: zip(legacySinglePlayerAINames, GameEngine.singlePlayerAINames)
  )

  /// Migrates only players explicitly marked as AI. History follows player IDs;
  /// free-form logs are reset so matching human display names remain untouched.
  public static func sanitized(_ state: GameState) -> GameState {
    var sanitized = state
    var migratedNamesByPlayerID: [String: String] = [:]

    for index in sanitized.players.indices where sanitized.players[index].kind == .ai {
      guard let replacement = nameMap[sanitized.players[index].name] else { continue }
      migratedNamesByPlayerID[sanitized.players[index].id] = replacement
      sanitized.players[index].name = replacement
    }
    guard !migratedNamesByPlayerID.isEmpty else { return state }

    sanitized.log = [migrationLog]
    for roundIndex in sanitized.roundHistory.indices {
      for scoreIndex in sanitized.roundHistory[roundIndex].scores.indices {
        let playerID = sanitized.roundHistory[roundIndex].scores[scoreIndex].playerId
        if let replacement = migratedNamesByPlayerID[playerID] {
          sanitized.roundHistory[roundIndex].scores[scoreIndex].name = replacement
        }
      }
    }
    return sanitized
  }
}

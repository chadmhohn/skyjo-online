import Foundation

public enum LegacyAiBranding {
  public static let legacySinglePlayerAINameHashes: [UInt64] = [
    0x5542973044ba0c68, 0x9f3f85ba04cab13e, 0xac8256732f2ee1e5, 0x9ae6fc0237d8afb7,
    0xafe3eb7f06cf202f, 0x3d1dff043d987346, 0x85c8a1fb52a15ab7, 0xee6fd5b540765848,
    0x708692de3ab5ed90, 0xe0955819920ee6ca, 0x3033b419bfa02a13, 0xa35ecc75e1a63dfd,
    0x15db540c53723910, 0xbd8e8196e922467e, 0x62e31137432d1fe6, 0x70869cde3ab5fe8e,
    0x154c2df12edb39b9, 0x6904e684cbab83aa, 0xe1658725233e340a, 0x0d9a4e19fcf1b81f,
    0x0da6d11908db12b4, 0xe9b4f319c69b459a, 0x33ea3f24c0e97c4c, 0xfe743368a6c0860a,
    0xeca47f02d4f81b4f, 0xc1ceaac0cbbd4ddb, 0xcf48420e2ba85239, 0xc5dbafcaae518a32,
    0x28e6cdf4c16ed09a, 0x301648985132870a, 0x3390f194f1a39efd, 0xe2a54c4261f312e6,
    0x3526fcd86112ad53, 0x691448561268b617, 0x48f69ffb3020dae9, 0xdbe59b5dddf6662f,
    0x9851ab19faa5abab, 0x0a1e4ea743727ac6, 0x9d5332236a829907, 0x8abe8498a5d71df8,
    0xac92af320d252ece, 0x804555af4a634330, 0x1600c52150714b7a, 0x731109b3731b49da,
    0x2b8dbccdfbf285e9, 0x61ab1a3103018ff7, 0x4c22effb7b224ea3, 0x5029bcfb33ca5378,
    0x4f0cd4b48a51b444, 0x2e5103b33e776a7c, 0x6f7c78a17ba65ed2, 0x032fcd9a5f580400,
    0xdd93da2166f81088, 0x2ea5e82b669fcb6f, 0x9b0efb0237fa0018, 0xf94473ead8b40629,
    0x5379e9c93462a981, 0x0c07397e36b12774, 0xc8bf5cc71dcfa6da, 0x89d3bad928c50762,
    0xa8f220a7ceb30d8d, 0x39136f7053bec6e3, 0x9e96e9ea46bb8fdf, 0x7d5436625717819c,
    0x58baa4d8757c813d, 0x037cf073608cdae4, 0x741b642bbe75c671, 0x987ab619fac8c370,
    0x16343819b0e5e58a, 0xb21b5d1c8513a7dd, 0x1c971033afe65892, 0xe1e93f121e054f19,
    0xf61e3f1a2d42578c, 0x20ae8773cce11f08, 0x3741fd19c32ad129, 0x657f87cad620172c,
    0x4e907860b881b794, 0x2f5bf6b5091cc732, 0xa5a48eb4bb5b6648, 0x49612e19cda89924,
    0x54ad30f3544c5a6c, 0xecdd0cf7a8a06409, 0x9ff1d319feac08cb, 0xd1fe1b84eebc2ffc,
    0x8da36d19f40675ff, 0xbbc49fd5115096a2, 0x9881dc8fb600030d,
  ]

  public static let migrationLog = "Earlier game activity was cleared during a Flipvale update."

  private static let nameMap = Dictionary(
    uniqueKeysWithValues: zip(legacySinglePlayerAINameHashes, GameEngine.singlePlayerAINames)
  )

  public static func legacyNameHash(_ name: String) -> UInt64? {
    guard name.unicodeScalars.allSatisfy({ $0.value <= 0x7f }) else { return nil }
    var hash: UInt64 = 14_695_981_039_346_656_037
    for byte in name.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 1_099_511_628_211
    }
    return hash
  }

  /// Migrates only players explicitly marked as AI. History follows player IDs;
  /// free-form logs are reset so matching human display names remain untouched.
  public static func sanitized(_ state: GameState) -> GameState {
    var sanitized = state
    var migratedNamesByPlayerID: [String: String] = [:]

    for index in sanitized.players.indices where sanitized.players[index].kind == .ai {
      guard
        let hash = legacyNameHash(sanitized.players[index].name),
        let replacement = nameMap[hash]
      else { continue }
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

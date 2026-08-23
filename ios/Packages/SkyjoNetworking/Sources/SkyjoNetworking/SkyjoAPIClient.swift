import Foundation
import SkyjoDomain

public enum AccountRole: String, Decodable, Equatable, Sendable {
  case admin
  case player
}

public enum APNSDeviceEnvironment: String, Encodable, Equatable, Sendable {
  case development
  case production
}

public struct APNSConfiguration: Decodable, Equatable, Sendable {
  public let enabled: Bool

  public init(enabled: Bool) {
    self.enabled = enabled
  }
}

public struct AccountUser: Decodable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let email: String
  public let displayName: String
  public let role: AccountRole
  public let disabled: Bool
  public let createdAt: Int64
  public let updatedAt: Int64
  public let lastLoginAt: Int64?

  public init(
    id: UUID,
    email: String,
    displayName: String,
    role: AccountRole,
    disabled: Bool,
    createdAt: Int64,
    updatedAt: Int64,
    lastLoginAt: Int64?
  ) {
    self.id = id
    self.email = email
    self.displayName = displayName
    self.role = role
    self.disabled = disabled
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.lastLoginAt = lastLoginAt
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decodeContractUUID(forKey: .id)
    email = try container.decode(String.self, forKey: .email)
    displayName = try container.decode(String.self, forKey: .displayName)
    role = try container.decode(AccountRole.self, forKey: .role)
    disabled = try container.decode(Bool.self, forKey: .disabled)
    createdAt = try container.decode(Int64.self, forKey: .createdAt)
    updatedAt = try container.decode(Int64.self, forKey: .updatedAt)
    lastLoginAt = try container.decodeRequiredNullable(Int64.self, forKey: .lastLoginAt)

    try container.requireContract(
      isValidAccountEmail(email),
      forKey: .email,
      description: "Invalid account email."
    )
    try container.requireContract(
      hasContractLength(displayName, in: 1...24),
      forKey: .displayName,
      description: "Invalid account display-name bounds."
    )
    try container.requireContract(
      isEpochMilliseconds(createdAt),
      forKey: .createdAt,
      description: "Invalid account creation timestamp."
    )
    try container.requireContract(
      isEpochMilliseconds(updatedAt),
      forKey: .updatedAt,
      description: "Invalid account update timestamp."
    )
    try container.requireContract(
      lastLoginAt.map(isEpochMilliseconds) ?? true,
      forKey: .lastLoginAt,
      description: "Invalid account login timestamp."
    )
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case email
    case displayName
    case role
    case disabled
    case createdAt
    case updatedAt
    case lastLoginAt
  }
}

public enum StatsGameMode: String, Decodable, Equatable, Sendable {
  case single
  case multi
}

public enum StatsPlayerKind: String, Decodable, Equatable, Sendable {
  case human
  case ai
}

public struct StatsParticipant: Decodable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let userId: UUID?
  public let playerId: String
  public let displayName: String
  public let kind: StatsPlayerKind
  public let rank: Int
  public let roundScore: Int
  public let totalScore: Int
  public let won: Bool

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decodeContractUUID(forKey: .id)
    userId = try container.decodeRequiredNullableContractUUID(forKey: .userId)
    playerId = try container.decode(String.self, forKey: .playerId)
    displayName = try container.decode(String.self, forKey: .displayName)
    kind = try container.decode(StatsPlayerKind.self, forKey: .kind)
    rank = try container.decode(Int.self, forKey: .rank)
    roundScore = try container.decode(Int.self, forKey: .roundScore)
    totalScore = try container.decode(Int.self, forKey: .totalScore)
    won = try container.decode(Bool.self, forKey: .won)

    try container.requireContract(
      isContractIdentifier(playerId),
      forKey: .playerId,
      description: "Invalid participant player identifier."
    )
    try container.requireContract(
      hasContractLength(displayName, in: 1...64),
      forKey: .displayName,
      description: "Invalid participant display-name bounds."
    )
    try container.requireContract(
      (1...8).contains(rank),
      forKey: .rank,
      description: "Invalid participant rank."
    )
    try container.requireContract(
      isContractScore(roundScore),
      forKey: .roundScore,
      description: "Invalid participant round score."
    )
    try container.requireContract(
      isContractScore(totalScore),
      forKey: .totalScore,
      description: "Invalid participant total score."
    )
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case userId
    case playerId
    case displayName
    case kind
    case rank
    case roundScore
    case totalScore
    case won
  }
}

public struct StatsRoundScore: Decodable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let round: Int
  public let playerId: String
  public let userId: UUID?
  public let displayName: String
  public let roundScore: Int
  public let totalScore: Int

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decodeContractUUID(forKey: .id)
    round = try container.decode(Int.self, forKey: .round)
    playerId = try container.decode(String.self, forKey: .playerId)
    userId = try container.decodeRequiredNullableContractUUID(forKey: .userId)
    displayName = try container.decode(String.self, forKey: .displayName)
    roundScore = try container.decode(Int.self, forKey: .roundScore)
    totalScore = try container.decode(Int.self, forKey: .totalScore)

    try container.requireContract(
      isSafeInteger(round, minimum: 1),
      forKey: .round,
      description: "Invalid round number."
    )
    try container.requireContract(
      isContractIdentifier(playerId),
      forKey: .playerId,
      description: "Invalid round player identifier."
    )
    try container.requireContract(
      hasContractLength(displayName, in: 1...64),
      forKey: .displayName,
      description: "Invalid round display-name bounds."
    )
    try container.requireContract(
      isContractScore(roundScore),
      forKey: .roundScore,
      description: "Invalid round score."
    )
    try container.requireContract(
      isContractScore(totalScore),
      forKey: .totalScore,
      description: "Invalid cumulative score."
    )
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case round
    case playerId
    case userId
    case displayName
    case roundScore
    case totalScore
  }
}

public struct StatsGame: Decodable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let mode: StatsGameMode
  public let roomCode: String?
  public let completedAt: Int64
  public let roundCount: Int
  public let winnerPlayerId: String?
  public let winnerName: String
  public let winnerUserId: UUID?
  public let createdByUserId: UUID?
  public let finishedByAi: Bool
  public let participants: [StatsParticipant]
  public let rounds: [StatsRoundScore]

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decodeContractUUID(forKey: .id)
    mode = try container.decode(StatsGameMode.self, forKey: .mode)
    roomCode = try container.decodeRequiredNullable(String.self, forKey: .roomCode)
    completedAt = try container.decode(Int64.self, forKey: .completedAt)
    roundCount = try container.decode(Int.self, forKey: .roundCount)
    winnerPlayerId = try container.decodeRequiredNullable(String.self, forKey: .winnerPlayerId)
    winnerName = try container.decode(String.self, forKey: .winnerName)
    winnerUserId = try container.decodeRequiredNullableContractUUID(forKey: .winnerUserId)
    createdByUserId = try container.decodeRequiredNullableContractUUID(forKey: .createdByUserId)
    finishedByAi = try container.decode(Bool.self, forKey: .finishedByAi)
    participants = try container.decode([StatsParticipant].self, forKey: .participants)
    rounds = try container.decode([StatsRoundScore].self, forKey: .rounds)

    try container.requireContract(
      roomCode.map(isContractRoomCode) ?? true,
      forKey: .roomCode,
      description: "Invalid room code."
    )
    try container.requireContract(
      completedAt >= 1 && completedAt <= maximumSafeJSONInteger,
      forKey: .completedAt,
      description: "Invalid game completion timestamp."
    )
    try container.requireContract(
      (1...256).contains(roundCount),
      forKey: .roundCount,
      description: "Invalid game round count."
    )
    try container.requireContract(
      winnerPlayerId.map(isContractIdentifier) ?? true,
      forKey: .winnerPlayerId,
      description: "Invalid winner player identifier."
    )
    try container.requireContract(
      hasContractLength(winnerName, in: 1...64),
      forKey: .winnerName,
      description: "Invalid winner-name bounds."
    )
    try container.requireContract(
      (1...8).contains(participants.count),
      forKey: .participants,
      description: "A stats game must contain one through eight participants."
    )
    try container.requireContract(
      (1...2_048).contains(rounds.count),
      forKey: .rounds,
      description: "A stats game must contain one through 2,048 round scores."
    )
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case mode
    case roomCode
    case completedAt
    case roundCount
    case winnerPlayerId
    case winnerName
    case winnerUserId
    case createdByUserId
    case finishedByAi
    case participants
    case rounds
  }
}

public struct StatsSummaryNumbers: Decodable, Equatable, Sendable {
  public let gamesPlayed: Int
  public let wins: Int
  public let multiplayerGames: Int
  public let singlePlayerGames: Int
  public let winRate: Double
  public let averageTotalScore: Double
  public let bestTotalScore: Int?

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    gamesPlayed = try container.decode(Int.self, forKey: .gamesPlayed)
    wins = try container.decode(Int.self, forKey: .wins)
    multiplayerGames = try container.decode(Int.self, forKey: .multiplayerGames)
    singlePlayerGames = try container.decode(Int.self, forKey: .singlePlayerGames)
    winRate = try container.decode(Double.self, forKey: .winRate)
    averageTotalScore = try container.decode(Double.self, forKey: .averageTotalScore)
    bestTotalScore = try container.decodeRequiredNullable(Int.self, forKey: .bestTotalScore)

    for (key, value) in [
      (CodingKeys.gamesPlayed, gamesPlayed),
      (.wins, wins),
      (.multiplayerGames, multiplayerGames),
      (.singlePlayerGames, singlePlayerGames),
    ] {
      try container.requireContract(
        value >= 0,
        forKey: key,
        description: "Invalid stats count."
      )
    }
    try container.requireContract(
      winRate.isFinite && (0...100).contains(winRate),
      forKey: .winRate,
      description: "Invalid stats win rate."
    )
    try container.requireContract(
      averageTotalScore.isFinite,
      forKey: .averageTotalScore,
      description: "Invalid stats average score."
    )
    try container.requireContract(
      bestTotalScore.map(isContractScore) ?? true,
      forKey: .bestTotalScore,
      description: "Invalid best score."
    )
  }

  private enum CodingKeys: String, CodingKey {
    case gamesPlayed
    case wins
    case multiplayerGames
    case singlePlayerGames
    case winRate
    case averageTotalScore
    case bestTotalScore
  }
}

public struct StatsCoPlayer: Decodable, Equatable, Identifiable, Sendable {
  public var id: UUID { userId }

  public let userId: UUID
  public let displayName: String
  public let gamesTogether: Int
  public let wins: Int
  public let averageTotalScore: Double
  public let latestAt: Int64

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    userId = try container.decodeContractUUID(forKey: .userId)
    displayName = try container.decode(String.self, forKey: .displayName)
    gamesTogether = try container.decode(Int.self, forKey: .gamesTogether)
    wins = try container.decode(Int.self, forKey: .wins)
    averageTotalScore = try container.decode(Double.self, forKey: .averageTotalScore)
    latestAt = try container.decode(Int64.self, forKey: .latestAt)

    try container.requireContract(
      hasContractLength(displayName, in: 1...24),
      forKey: .displayName,
      description: "Invalid co-player display-name bounds."
    )
    try container.requireContract(
      gamesTogether >= 1,
      forKey: .gamesTogether,
      description: "Invalid co-player game count."
    )
    try container.requireContract(
      wins >= 0,
      forKey: .wins,
      description: "Invalid co-player win count."
    )
    try container.requireContract(
      averageTotalScore.isFinite,
      forKey: .averageTotalScore,
      description: "Invalid co-player average score."
    )
    try container.requireContract(
      isEpochMilliseconds(latestAt),
      forKey: .latestAt,
      description: "Invalid co-player timestamp."
    )
  }

  private enum CodingKeys: String, CodingKey {
    case userId
    case displayName
    case gamesTogether
    case wins
    case averageTotalScore
    case latestAt
  }
}

public struct StatsAdminSummary: Decodable, Equatable, Sendable {
  public let users: Int
  public let games: Int

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    users = try container.decode(Int.self, forKey: .users)
    games = try container.decode(Int.self, forKey: .games)

    try container.requireContract(
      users >= 0,
      forKey: .users,
      description: "Invalid admin user count."
    )
    try container.requireContract(
      games >= 0,
      forKey: .games,
      description: "Invalid admin game count."
    )
  }

  private enum CodingKeys: String, CodingKey {
    case users
    case games
  }
}

public struct StatsSummary: Decodable, Equatable, Sendable {
  public let `self`: StatsSummaryNumbers
  public let coPlayers: [StatsCoPlayer]
  public let recentGames: [StatsGame]
  public let admin: StatsAdminSummary?

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.`self` = try container.decode(StatsSummaryNumbers.self, forKey: .selfSummary)
    coPlayers = try container.decode([StatsCoPlayer].self, forKey: .coPlayers)
    recentGames = try container.decode([StatsGame].self, forKey: .recentGames)
    admin = try container.decodeRequiredNullable(StatsAdminSummary.self, forKey: .admin)

    try container.requireContract(
      recentGames.count <= 8,
      forKey: .recentGames,
      description: "A stats summary may contain at most eight recent games."
    )
  }

  private enum CodingKeys: String, CodingKey {
    case selfSummary = "self"
    case coPlayers
    case recentGames
    case admin
  }
}

public struct PlayerStats: Decodable, Equatable, Sendable {
  public let user: AccountUser
  public let summary: StatsSummaryNumbers
  public let games: [StatsGame]
}

/// Immutable body used by the durable native solo-stats outbox. UUIDs are encoded in canonical
/// lowercase form so an acknowledgement-loss retry sends the exact same idempotency key and
/// account fence.
public struct SinglePlayerStatsSubmission: Encodable, Equatable, Sendable {
  public let state: GameState
  public let clientGameKey: String
  public let completedAt: Int64
  public let expectedAccountUserId: String

  public init(
    state: GameState,
    clientGameID: UUID,
    completedAt: Int64,
    expectedAccountUserID: UUID
  ) {
    self.state = state
    clientGameKey = clientGameID.uuidString.lowercased()
    self.completedAt = completedAt
    expectedAccountUserId = expectedAccountUserID.uuidString.lowercased()
  }
}

public enum ServiceReadinessStatus: String, Decodable, Equatable, Sendable {
  case ready
  case notReady = "not_ready"
}

public enum ServiceCheckStatus: String, Decodable, Equatable, Sendable {
  case ok
  case error
}

public struct ServiceReadinessChecks: Decodable, Equatable, Sendable {
  public let database: ServiceCheckStatus
  public let roomState: ServiceCheckStatus
  public let lastPersist: ServiceCheckStatus
}

public struct ServiceReadiness: Decodable, Equatable, Sendable {
  public let status: ServiceReadinessStatus
  public let releaseSha: String?
  public let schemaVersion: Int
  public let protocolVersion: Int
  public let checks: ServiceReadinessChecks

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    guard schemaVersion == 2 else {
      throw OperationalContractDecodingError.unsupportedVersion
    }
    protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
    guard protocolVersion == 2 else {
      throw OperationalContractDecodingError.unsupportedVersion
    }

    status = try container.decode(ServiceReadinessStatus.self, forKey: .status)
    releaseSha = try container.decodeRequiredNullable(String.self, forKey: .releaseSha)
    checks = try container.decode(ServiceReadinessChecks.self, forKey: .checks)
    guard releaseSha.map(isValidReleaseIdentity) ?? true else {
      throw DecodingError.dataCorruptedError(
        forKey: .releaseSha,
        in: container,
        debugDescription: "Invalid release identity."
      )
    }
  }

  private enum CodingKeys: String, CodingKey {
    case status
    case releaseSha
    case schemaVersion
    case protocolVersion
    case checks
  }
}

public enum ServiceVersion: Decodable, Equatable, Sendable {
  case available(releaseSha: String, buildTimestamp: String, protocolVersion: Int)
  case unavailable

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if container.contains(.protocolVersion) {
      let protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
      guard protocolVersion == 2 else {
        throw OperationalContractDecodingError.unsupportedVersion
      }
      if container.contains(.status) {
        throw DecodingError.dataCorruptedError(
          forKey: .status,
          in: container,
          debugDescription: "Unexpected version status."
        )
      }

      let releaseSha = try container.decode(String.self, forKey: .releaseSha)
      let buildTimestamp = try container.decode(String.self, forKey: .buildTimestamp)
      guard isValidReleaseIdentity(releaseSha) else {
        throw DecodingError.dataCorruptedError(
          forKey: .releaseSha,
          in: container,
          debugDescription: "Invalid release identity."
        )
      }
      guard isValidBuildTimestamp(buildTimestamp) else {
        throw DecodingError.dataCorruptedError(
          forKey: .buildTimestamp,
          in: container,
          debugDescription: "Invalid build timestamp."
        )
      }

      self = .available(
        releaseSha: releaseSha,
        buildTimestamp: buildTimestamp,
        protocolVersion: protocolVersion
      )
      return
    }

    let status = try container.decode(String.self, forKey: .status)
    guard status == "unavailable" else {
      throw DecodingError.dataCorruptedError(
        forKey: .status,
        in: container,
        debugDescription: "Invalid unavailable-version status."
      )
    }
    self = .unavailable
  }

  private enum CodingKeys: String, CodingKey {
    case status
    case releaseSha
    case buildTimestamp
    case protocolVersion
  }
}

public actor SkyjoAPIClient {
  public static let maximumRequestBytes = 256 * 1024
  public static let maximumResponseBytes = 2 * 1024 * 1024

  private let environment: SkyjoNetworkEnvironment
  private let session: URLSession
  private let accessClient: AccessSessionClient
  private let roomResetRecoveryStore: any RoomResetRecoveryStore
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  public init(
    environment: SkyjoNetworkEnvironment,
    session: URLSession,
    roomResetRecoveryStore: any RoomResetRecoveryStore =
      FileRoomResetRecoveryStore.applicationSupportStore()
  ) {
    self.environment = environment
    self.session = session
    self.roomResetRecoveryStore = roomResetRecoveryStore
    accessClient = AccessSessionClient(
      environment: environment,
      session: session,
      cookieStorage: session.configuration.httpCookieStorage ?? .shared
    )
  }

  public init(
    environment: SkyjoNetworkEnvironment,
    persistentCookieStorage: HTTPCookieStorage = .shared,
    roomResetRecoveryStore: any RoomResetRecoveryStore =
      FileRoomResetRecoveryStore.applicationSupportStore()
  ) {
    self.environment = environment
    self.roomResetRecoveryStore = roomResetRecoveryStore
    let dedicatedSession = SkyjoURLSessionFactory.makeDedicated(cookieStorage: persistentCookieStorage)
    session = dedicatedSession
    accessClient = AccessSessionClient(
      environment: environment,
      session: dedicatedSession,
      cookieStorage: persistentCookieStorage
    )
  }

  public func accessStatus() async throws -> AccessSessionStatus {
    try await accessClient.status()
  }

  public func loginAccess(password: String) async throws -> AccessSessionStatus {
    try await accessClient.login(password: password)
  }

  public func logoutAccess() async throws -> AccessSessionStatus {
    try await accessClient.logout()
  }

  public func currentAccount() async throws -> AccountUser? {
    let response: AccountEnvelope = try await request(
      path: "api/account/me",
      method: "GET",
      successStatusCodes: [200]
    )
    return response.user
  }

  public func signup(
    email: String,
    displayName: String,
    password: String,
    confirmPassword: String
  ) async throws -> AccountUser {
    let response: RequiredAccountEnvelope = try await request(
      path: "api/account/signup",
      method: "POST",
      body: SignupRequest(
        email: email,
        displayName: displayName,
        password: password,
        confirmPassword: confirmPassword
      ),
      successStatusCodes: [201]
    )
    return response.user
  }

  public func loginAccount(email: String, password: String) async throws -> AccountUser {
    let response: RequiredAccountEnvelope = try await request(
      path: "api/account/login",
      method: "POST",
      body: AccountLoginRequest(email: email, password: password),
      successStatusCodes: [200]
    )
    return response.user
  }

  public func logoutAccount(apnsInstallationID: UUID? = nil) async throws {
    let response: OKEnvelope
    if let apnsInstallationID {
      response = try await request(
        path: "api/account/logout",
        method: "POST",
        body: APNSLogoutRequest(
          installationId: apnsInstallationID.uuidString.lowercased()
        ),
        successStatusCodes: [200]
      )
    } else {
      response = try await request(
        path: "api/account/logout",
        method: "POST",
        successStatusCodes: [200]
      )
    }
    guard response.ok else { throw SkyjoHTTPClientError.invalidSuccessPayload }
  }

  public func apnsConfiguration() async throws -> APNSConfiguration {
    try await request(
      path: "api/push/apns/config",
      method: "GET",
      successStatusCodes: [200]
    )
  }

  public func registerAPNSDevice(
    installationID: UUID,
    deviceToken: String,
    environment: APNSDeviceEnvironment,
    appVersion: String,
    locale: String
  ) async throws {
    let response: OKEnvelope = try await request(
      path: "api/push/apns/devices/\(installationID.uuidString.lowercased())",
      method: "PUT",
      body: APNSRegistrationRequest(
        deviceToken: deviceToken,
        environment: environment,
        appVersion: appVersion,
        locale: locale
      ),
      successStatusCodes: [200]
    )
    guard response.ok else { throw SkyjoHTTPClientError.invalidSuccessPayload }
  }

  public func deleteAPNSDevice(installationID: UUID) async throws {
    let response: OKEnvelope = try await request(
      path: "api/push/apns/devices/\(installationID.uuidString.lowercased())",
      method: "DELETE",
      successStatusCodes: [200]
    )
    guard response.ok else { throw SkyjoHTTPClientError.invalidSuccessPayload }
  }

  public func updateProfile(displayName: String) async throws -> AccountUser {
    let response: RequiredAccountEnvelope = try await request(
      path: "api/account/profile",
      method: "PATCH",
      body: ProfileRequest(displayName: displayName),
      successStatusCodes: [200]
    )
    return response.user
  }

  public func changePassword(
    currentPassword: String,
    password: String,
    confirmPassword: String
  ) async throws {
    let response: OKEnvelope = try await request(
      path: "api/account/password",
      method: "POST",
      body: PasswordRequest(
        currentPassword: currentPassword,
        password: password,
        confirmPassword: confirmPassword
      ),
      successStatusCodes: [200]
    )
    guard response.ok else { throw SkyjoHTTPClientError.invalidSuccessPayload }
  }

  public func deleteAccount(currentPassword: String, confirmation: String) async throws {
    let response: OKEnvelope = try await request(
      path: "api/account",
      method: "DELETE",
      body: AccountDeletionRequest(
        currentPassword: currentPassword,
        confirmation: confirmation
      ),
      successStatusCodes: [200]
    )
    guard response.ok else { throw SkyjoHTTPClientError.invalidSuccessPayload }
  }

  public func statsSummary() async throws -> StatsSummary {
    try await request(path: "api/stats/summary", method: "GET", successStatusCodes: [200])
  }

  public func statsGames() async throws -> [StatsGame] {
    let response: GamesEnvelope = try await request(
      path: "api/stats/games",
      method: "GET",
      successStatusCodes: [200]
    )
    return response.games
  }

  public func statsGame(id: UUID) async throws -> StatsGame {
    let response: GameEnvelope = try await request(
      path: "api/stats/games/\(id.uuidString.lowercased())",
      method: "GET",
      successStatusCodes: [200]
    )
    guard response.game.id == id else {
      throw SkyjoHTTPClientError.invalidSuccessPayload
    }
    return response.game
  }

  public func playerStats(userID: UUID) async throws -> PlayerStats {
    let response: PlayerStats = try await request(
      path: "api/stats/players/\(userID.uuidString.lowercased())",
      method: "GET",
      successStatusCodes: [200]
    )
    guard response.user.id == userID else {
      throw SkyjoHTTPClientError.invalidSuccessPayload
    }
    return response
  }

  @discardableResult
  public func submitSinglePlayerStats(
    _ submission: SinglePlayerStatsSubmission
  ) async throws -> StatsGame {
    let response: GameEnvelope = try await request(
      path: "api/stats/single-player",
      method: "POST",
      body: submission,
      successStatusCodes: [201]
    )
    guard response.game.mode == .single else {
      throw SkyjoHTTPClientError.invalidSuccessPayload
    }
    return response.game
  }

  public func readiness() async throws -> ServiceReadiness {
    try await request(path: "readyz", method: "GET", successStatusCodes: [200, 503])
  }

  public func version() async throws -> ServiceVersion {
    try await request(path: "version", method: "GET", successStatusCodes: [200, 503])
  }

  /// Creates the realtime actor on the exact URLSession that owns both signed
  /// HttpOnly session cookies. Cookie values never cross this API boundary.
  public func makeRoomConnection(confirmedAccount: AccountUser) throws -> RoomConnection {
    let webSocketURL = try Self.roomWebSocketURL(for: environment.baseURL)
    return try RoomConnection(
      webSocketURL: webSocketURL,
      confirmedAccount: try ConfirmedRoomAccount(
        accountID: confirmedAccount.id,
        displayName: confirmedAccount.displayName
      ),
      environment: .live(session: session, resetRecoveryStore: roomResetRecoveryStore)
    )
  }

  public nonisolated static func roomWebSocketURL(for baseURL: URL) throws -> URL {
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
          let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          components.host != nil,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil,
          components.path.isEmpty || components.path == "/"
    else { throw RoomConnectionError.invalidWebSocketURL }
    components.scheme = scheme == "https" ? "wss" : "ws"
    components.path = "/rooms"
    guard let url = components.url else { throw RoomConnectionError.invalidWebSocketURL }
    return url
  }

  private func request<Response: Decodable & Sendable>(
    path: String,
    method: String,
    successStatusCodes: Set<Int>
  ) async throws -> Response {
    try await request(path: path, method: method, bodyData: nil, successStatusCodes: successStatusCodes)
  }

  private func request<Response: Decodable & Sendable, Body: Encodable & Sendable>(
    path: String,
    method: String,
    body: Body,
    successStatusCodes: Set<Int>
  ) async throws -> Response {
    let data = try encoder.encode(body)
    guard data.count <= Self.maximumRequestBytes else {
      throw SkyjoHTTPClientError.requestTooLarge(limit: Self.maximumRequestBytes)
    }
    return try await request(
      path: path,
      method: method,
      bodyData: data,
      successStatusCodes: successStatusCodes
    )
  }

  private func request<Response: Decodable & Sendable>(
    path: String,
    method: String,
    bodyData: Data?,
    successStatusCodes: Set<Int>
  ) async throws -> Response {
    let endpoint = environment.baseURL.appending(path: path)
    var request = URLRequest(url: endpoint)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    if let bodyData {
      request.httpBody = bodyData
      request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
    }

    let bytes: URLSession.AsyncBytes
    let response: URLResponse
    do {
      (bytes, response) = try await session.bytes(for: request)
    } catch let error as URLError {
      throw SkyjoHTTPClientError.transport(error.code)
    } catch {
      throw SkyjoHTTPClientError.transport(.unknown)
    }

    guard let httpResponse = response as? HTTPURLResponse else {
      bytes.task.cancel()
      throw SkyjoHTTPClientError.invalidHTTPResponse
    }
    guard httpResponse.url == endpoint else {
      bytes.task.cancel()
      throw SkyjoHTTPClientError.redirected
    }
    guard !(300..<400).contains(httpResponse.statusCode) else {
      bytes.task.cancel()
      throw SkyjoHTTPClientError.redirected
    }
    guard response.expectedContentLength <= Int64(Self.maximumResponseBytes) else {
      bytes.task.cancel()
      throw SkyjoHTTPClientError.responseTooLarge(limit: Self.maximumResponseBytes)
    }

    var data = Data()
    if response.expectedContentLength > 0 {
      data.reserveCapacity(Int(response.expectedContentLength))
    }
    do {
      for try await byte in bytes {
        guard data.count < Self.maximumResponseBytes else {
          bytes.task.cancel()
          throw SkyjoHTTPClientError.responseTooLarge(limit: Self.maximumResponseBytes)
        }
        data.append(byte)
      }
    } catch let error as SkyjoHTTPClientError {
      throw error
    } catch let error as URLError {
      throw SkyjoHTTPClientError.transport(error.code)
    } catch {
      throw SkyjoHTTPClientError.transport(.unknown)
    }

    guard Self.isJSONResponse(httpResponse) else {
      if successStatusCodes.contains(httpResponse.statusCode) {
        throw SkyjoHTTPClientError.invalidSuccessPayload
      }
      throw SkyjoHTTPClientError.server(
        statusCode: httpResponse.statusCode,
        code: nil,
        message: SkyjoHTTPClientError.safeFallbackMessage
      )
    }

    if successStatusCodes.contains(httpResponse.statusCode) {
      do {
        return try decoder.decode(Response.self, from: data)
      } catch OperationalContractDecodingError.unsupportedVersion {
        throw SkyjoHTTPClientError.unsupportedServerVersion
      } catch {
        throw SkyjoHTTPClientError.invalidSuccessPayload
      }
    }

    throw decodeServerError(statusCode: httpResponse.statusCode, data: data)
  }

  private func decodeServerError(statusCode: Int, data: Data) -> SkyjoHTTPClientError {
    guard let payload = try? decoder.decode(APIErrorPayload.self, from: data) else {
      return .server(
        statusCode: statusCode,
        code: nil,
        message: SkyjoHTTPClientError.safeFallbackMessage
      )
    }

    let code = SkyjoAPIErrorCode(rawValue: payload.code)
    return .server(
      statusCode: statusCode,
      code: code,
      message: code.isKnown ? payload.error : SkyjoHTTPClientError.safeFallbackMessage
    )
  }

  private static func isJSONResponse(_ response: HTTPURLResponse) -> Bool {
    guard let contentType = response.value(forHTTPHeaderField: "Content-Type") else { return false }
    let mediaType = contentType.split(separator: ";", maxSplits: 1).first?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    return mediaType == "application/json"
  }
}

private enum OperationalContractDecodingError: Error {
  case unsupportedVersion
}

private let maximumSafeJSONInteger: Int64 = 9_007_199_254_740_991
private let contractScoreRange = -1_000_000_000...1_000_000_000

private func hasContractLength(_ value: String, in range: ClosedRange<Int>) -> Bool {
  range.contains(value.unicodeScalars.count)
}

private func isValidAccountEmail(_ value: String) -> Bool {
  hasContractLength(value, in: 3...254)
    && value.range(
      of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#,
      options: .regularExpression
    ) != nil
}

private func isContractIdentifier(_ value: String) -> Bool {
  hasContractLength(value, in: 1...128)
    && value.unicodeScalars.allSatisfy { scalar in
      scalar.value > 0x1F && scalar.value != 0x7F
    }
}

private func isContractRoomCode(_ value: String) -> Bool {
  let scalars = value.unicodeScalars
  return scalars.count == 5
    && scalars.allSatisfy { scalar in
      (0x30...0x39).contains(scalar.value) || (0x41...0x5A).contains(scalar.value)
    }
}

private func isContractUUID(_ value: String) -> UUID? {
  let bytes = Array(value.utf8)
  guard bytes.count == 36 else { return nil }
  let hyphenOffsets = Set([8, 13, 18, 23])
  for (offset, byte) in bytes.enumerated() {
    if hyphenOffsets.contains(offset) {
      guard byte == 0x2D else { return nil }
    } else {
      guard
        (0x30...0x39).contains(byte)
          || (0x41...0x46).contains(byte)
          || (0x61...0x66).contains(byte)
      else { return nil }
    }
  }
  guard (0x31...0x38).contains(bytes[14]) else { return nil }
  guard [0x38, 0x39, 0x41, 0x42, 0x61, 0x62].contains(bytes[19]) else { return nil }
  return UUID(uuidString: value)
}

private func isEpochMilliseconds(_ value: Int64) -> Bool {
  (0...maximumSafeJSONInteger).contains(value)
}

private func isSafeInteger(_ value: Int, minimum: Int = 0) -> Bool {
  value >= minimum && Int64(value) <= maximumSafeJSONInteger
}

private func isContractScore(_ value: Int) -> Bool {
  contractScoreRange.contains(value)
}

private func isValidReleaseIdentity(_ value: String) -> Bool {
  if value == "development" { return true }
  return (7...64).contains(value.count)
    && value.allSatisfy { character in
      character.isASCII
        && (character.isNumber || ("a"..."f").contains(String(character)))
    }
}

private func isValidBuildTimestamp(_ value: String) -> Bool {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if formatter.date(from: value) != nil { return true }
  formatter.formatOptions = [.withInternetDateTime]
  return formatter.date(from: value) != nil
}

private extension KeyedDecodingContainer {
  func decodeContractUUID(forKey key: Key) throws -> UUID {
    let value = try decode(String.self, forKey: key)
    guard let uuid = isContractUUID(value) else {
      throw DecodingError.dataCorruptedError(
        forKey: key,
        in: self,
        debugDescription: "Invalid UUID."
      )
    }
    return uuid
  }

  func decodeRequiredNullableContractUUID(forKey key: Key) throws -> UUID? {
    guard contains(key) else {
      throw DecodingError.keyNotFound(
        key,
        .init(codingPath: codingPath, debugDescription: "Required nullable field is missing.")
      )
    }
    guard try !decodeNil(forKey: key) else { return nil }
    return try decodeContractUUID(forKey: key)
  }

  func decodeRequiredNullable<Value: Decodable>(
    _ type: Value.Type,
    forKey key: Key
  ) throws -> Value? {
    guard contains(key) else {
      throw DecodingError.keyNotFound(
        key,
        .init(codingPath: codingPath, debugDescription: "Required nullable field is missing.")
      )
    }
    return try decodeIfPresent(type, forKey: key)
  }

  func requireContract(
    _ condition: @autoclosure () -> Bool,
    forKey key: Key,
    description: String
  ) throws {
    guard condition() else {
      throw DecodingError.dataCorruptedError(
        forKey: key,
        in: self,
        debugDescription: description
      )
    }
  }
}

private struct AccountLoginRequest: Encodable, Sendable {
  let email: String
  let password: String
}

private struct SignupRequest: Encodable, Sendable {
  let email: String
  let displayName: String
  let password: String
  let confirmPassword: String
}

private struct ProfileRequest: Encodable, Sendable {
  let displayName: String
}

private struct PasswordRequest: Encodable, Sendable {
  let currentPassword: String
  let password: String
  let confirmPassword: String
}

private struct AccountDeletionRequest: Encodable, Sendable {
  let currentPassword: String
  let confirmation: String
}

private struct APNSLogoutRequest: Encodable, Sendable {
  let installationId: String
}

private struct APNSRegistrationRequest: Encodable, Sendable {
  let deviceToken: String
  let environment: APNSDeviceEnvironment
  let appVersion: String
  let locale: String
}

private struct AccountEnvelope: Decodable, Sendable {
  let user: AccountUser?

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    user = try container.decodeRequiredNullable(AccountUser.self, forKey: .user)
  }

  private enum CodingKeys: String, CodingKey {
    case user
  }
}

private struct RequiredAccountEnvelope: Decodable, Sendable {
  let user: AccountUser
}

private struct OKEnvelope: Decodable, Sendable {
  let ok: Bool
}

private struct GamesEnvelope: Decodable, Sendable {
  let games: [StatsGame]
}

private struct GameEnvelope: Decodable, Sendable {
  let game: StatsGame
}

private struct APIErrorPayload: Decodable, Sendable {
  let code: String
  let error: String

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let code = try container.decode(String.self, forKey: .code)
    let error = try container.decode(String.self, forKey: .error)
    guard
      (1...128).contains(code.unicodeScalars.count),
      code.allSatisfy({ $0 == "_" || $0.isASCII && ($0.isUppercase || $0.isNumber) }),
      (1...512).contains(error.unicodeScalars.count)
    else {
      throw DecodingError.dataCorrupted(
        .init(codingPath: decoder.codingPath, debugDescription: "Invalid API-error bounds.")
      )
    }

    self.code = code
    self.error = error
  }

  private enum CodingKeys: String, CodingKey {
    case code
    case error
  }
}

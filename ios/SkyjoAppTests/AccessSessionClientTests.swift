import Foundation
import SkyjoDomain
import SkyjoNetworking
import SkyjoPersistence
import Testing

@testable import SkyjoNative

@Suite("Access, account, and stats HTTP clients", .serialized)
struct AccessSessionClientTests {
  @Test("Status requires its typed field and tolerates additive fields")
  func statusResponseCompatibility() async throws {
    let fixture = makeFixture { request in
      try stubResponse(for: request, body: #"{"authenticated":false}"#)
    }
    defer { fixture.dispose() }

    #expect(fixture.session.configuration.urlCache == nil)
    #expect(fixture.session.configuration.urlCredentialStorage == nil)

    let status = try await fixture.client.status()
    #expect(status == AccessSessionStatus(authenticated: false))

    StubURLProtocol.install { request in
      try stubResponse(for: request, body: #"{"authenticated":false,"extra":true}"#)
    }
    #expect(try await fixture.client.status() == AccessSessionStatus(authenticated: false))

    StubURLProtocol.install { request in
      try stubResponse(for: request, body: #"{"extra":true}"#)
    }
    await expectError(.invalidSuccessPayload) {
      _ = try await fixture.client.status()
    }

    StubURLProtocol.install { request in
      try stubResponse(for: request, body: #"{"authenticated":"false"}"#)
    }
    await expectError(.invalidSuccessPayload) {
      _ = try await fixture.client.status()
    }
  }

  @Test("Login sends only the password contract and decodes a known stable error")
  func knownLoginError() async {
    let password = "synthetic-password-that-is-never-logged"
    let requestWasExact = LockedValue(false)
    let fixture = makeFixture { request in
      guard
        let body = requestBody(request),
        let payload = try JSONSerialization.jsonObject(with: body) as? [String: String]
      else {
        throw StubError.invalidRequest
      }
      requestWasExact.set(
        request.httpMethod == "POST"
          && request.url?.path == "/api/access/session"
          && request.value(forHTTPHeaderField: "Accept") == "application/json"
          && request.value(forHTTPHeaderField: "Content-Type") == "application/json; charset=utf-8"
          && Set(payload.keys) == ["password"]
          && payload["password"] == password
      )
      return try stubResponse(
        for: request,
        statusCode: 401,
        body: #"{"code":"ACCESS_AUTHENTICATION_FAILED","error":"Authentication failed.","future":true}"#
      )
    }
    defer { fixture.dispose() }

    await expectError(
      .server(
        statusCode: 401,
        code: .accessAuthenticationFailed,
        message: "Authentication failed."
      )
    ) {
      _ = try await fixture.client.login(password: password)
    }
    #expect(requestWasExact.get())
  }

  @Test("Unknown and malformed server errors use a safe fallback")
  func safeErrorFallbacks() async {
    let fixture = makeFixture { request in
      try stubResponse(
        for: request,
        statusCode: 409,
        body: #"{"code":"FUTURE_SERVER_CODE","error":"Untrusted future detail."}"#
      )
    }
    defer { fixture.dispose() }

    await expectError(
      .server(
        statusCode: 409,
        code: SkyjoAPIErrorCode(rawValue: "FUTURE_SERVER_CODE"),
        message: SkyjoHTTPClientError.safeFallbackMessage
      )
    ) {
      _ = try await fixture.client.status()
    }

    StubURLProtocol.install { request in
      try stubResponse(for: request, statusCode: 500, body: #"{"error":"Missing code."}"#)
    }
    await expectError(
      .server(statusCode: 500, code: nil, message: SkyjoHTTPClientError.safeFallbackMessage)
    ) {
      _ = try await fixture.client.status()
    }

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 500,
        body: "Internal error",
        contentType: "text/plain; charset=utf-8"
      )
    }
    await expectError(
      .server(statusCode: 500, code: nil, message: SkyjoHTTPClientError.safeFallbackMessage)
    ) {
      _ = try await fixture.client.status()
    }
  }

  @Test("API error messages enforce Unicode code-point bounds on both clients")
  func apiErrorUnicodeScalarBounds() async {
    let maximumMessage = "M" + String(repeating: "\u{0301}", count: 511)
    let oversizedMessage = maximumMessage + "\u{0301}"
    #expect(maximumMessage.unicodeScalars.count == 512)
    #expect(oversizedMessage.unicodeScalars.count == 513)

    do {
      let fixture = makeFixture { request in
        try stubResponse(
          for: request,
          statusCode: 401,
          body: "{\"code\":\"ACCESS_AUTHENTICATION_FAILED\",\"error\":\"\(maximumMessage)\"}"
        )
      }
      defer { fixture.dispose() }

      await expectError(
        .server(
          statusCode: 401,
          code: .accessAuthenticationFailed,
          message: maximumMessage
        )
      ) {
        _ = try await fixture.client.status()
      }

      StubURLProtocol.install { request in
        try stubResponse(
          for: request,
          statusCode: 401,
          body: "{\"code\":\"ACCESS_AUTHENTICATION_FAILED\",\"error\":\"\(oversizedMessage)\"}"
        )
      }
      await expectError(
        .server(
          statusCode: 401,
          code: nil,
          message: SkyjoHTTPClientError.safeFallbackMessage
        )
      ) {
        _ = try await fixture.client.status()
      }
    }

    let baseURL = URL(string: "https://unicode-error-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 401,
        body: "{\"code\":\"ACCOUNT_AUTHENTICATION_REQUIRED\",\"error\":\"\(maximumMessage)\"}"
      )
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    await expectError(
      .server(
        statusCode: 401,
        code: .accountAuthenticationRequired,
        message: maximumMessage
      )
    ) {
      _ = try await client.statsSummary()
    }

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 401,
        body: "{\"code\":\"ACCOUNT_AUTHENTICATION_REQUIRED\",\"error\":\"\(oversizedMessage)\"}"
      )
    }
    await expectError(
      .server(
        statusCode: 401,
        code: nil,
        message: SkyjoHTTPClientError.safeFallbackMessage
      )
    ) {
      _ = try await client.statsSummary()
    }
  }

  @Test("Request, response, and redirect boundaries fail closed")
  func boundaries() async throws {
    let fixture = makeFixture { request in
      try stubResponse(
        for: request,
        bodyData: Data(repeating: 0x20, count: AccessSessionClient.maximumResponseBytes + 1)
      )
    }
    defer { fixture.dispose() }

    await expectError(.responseTooLarge(limit: AccessSessionClient.maximumResponseBytes)) {
      _ = try await fixture.client.status()
    }

    let exactLimitBody = {
      var body = Data(#"{"authenticated":false}"#.utf8)
      body.append(
        Data(
          repeating: 0x20,
          count: AccessSessionClient.maximumResponseBytes - body.count
        )
      )
      return body
    }()
    StubURLProtocol.install { request in
      try stubResponse(for: request, bodyData: exactLimitBody)
    }
    #expect(try await fixture.client.status() == AccessSessionStatus(authenticated: false))

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        body: #"{"authenticated":false}"#,
        additionalHeaders: [
          "Content-Length": String(AccessSessionClient.maximumResponseBytes + 1),
        ]
      )
    }
    await expectError(.responseTooLarge(limit: AccessSessionClient.maximumResponseBytes)) {
      _ = try await fixture.client.status()
    }

    await expectError(.requestTooLarge(limit: AccessSessionClient.maximumRequestBytes)) {
      _ = try await fixture.client.login(
        password: String(repeating: "x", count: AccessSessionClient.maximumRequestBytes)
      )
    }

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 302,
        body: "",
        contentType: "text/plain; charset=utf-8",
        additionalHeaders: ["Location": "/login"]
      )
    }
    await expectError(.redirected) {
      _ = try await fixture.client.status()
    }
  }

  @Test("Unknown-length overflow cancels upstream delivery")
  func streamedOverflowCancelsUpstream() async {
    let totalBytes = AccessSessionClient.maximumResponseBytes * 8
    let generation = StreamingURLProtocol.reset(totalBytes: totalBytes)
    let baseURL = URL(string: "https://native-stream-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StreamingURLProtocol.self]
    )
    let client = AccessSessionClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session,
      cookieStorage: cookieStorage
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
    }

    await expectError(.responseTooLarge(limit: AccessSessionClient.maximumResponseBytes)) {
      _ = try await client.status()
    }

    for _ in 0..<100 where !StreamingURLProtocol.wasStopped(generation) {
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(StreamingURLProtocol.wasStopped(generation))
    #expect(StreamingURLProtocol.deliveredBytes(generation) < totalBytes)
  }

  private func makeFixture(
    handler: @escaping StubURLProtocol.Handler
  ) -> ClientFixture {
    StubURLProtocol.install(handler)
    let baseURL = URL(string: "https://native-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let environment = SkyjoNetworkEnvironment(baseURL: baseURL)
    return ClientFixture(
      client: AccessSessionClient(
        environment: environment,
        session: session,
        cookieStorage: cookieStorage
      ),
      session: session,
      cookieStorage: cookieStorage,
      cookieURL: baseURL
    )
  }
  @Test("Production API client preserves the access route response boundary")
  func productionAccessBoundary() async {
    let baseURL = URL(string: "https://access-api-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        bodyData: Data(repeating: 0x20, count: AccessSessionClient.maximumResponseBytes + 1)
      )
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    await expectError(.responseTooLarge(limit: AccessSessionClient.maximumResponseBytes)) {
      _ = try await client.accessStatus()
    }

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 302,
        body: "",
        contentType: "text/plain; charset=utf-8",
        additionalHeaders: ["Location": "/login"]
      )
    }
    await expectError(.redirected) {
      _ = try await client.accessStatus()
    }
  }

  @Test("General API client enforces the 256 KiB encoded request boundary")
  func productionGeneralRequestBoundary() async throws {
    let baseURL = URL(string: "https://request-boundary-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let requestCount = LockedValue(0)
    let emptyBodyBytes = Data(#"{"displayName":""}"#.utf8).count
    let exactDisplayName = String(
      repeating: "x",
      count: SkyjoAPIClient.maximumRequestBytes - emptyBodyBytes
    )

    StubURLProtocol.install { request in
      let body = try #require(requestBody(request))
      requestCount.set(requestCount.get() + 1)
      #expect(body.count == SkyjoAPIClient.maximumRequestBytes)
      return try stubResponse(for: request, body: accountUserEnvelopeJSON())
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    _ = try await client.updateProfile(displayName: exactDisplayName)
    #expect(requestCount.get() == 1)

    await expectError(.requestTooLarge(limit: SkyjoAPIClient.maximumRequestBytes)) {
      _ = try await client.updateProfile(displayName: exactDisplayName + "x")
    }
    #expect(requestCount.get() == 1)
  }

  @Test("General API client streams the 2 MiB response boundary and cancels overflow")
  func productionGeneralStreamingResponseBoundary() async throws {
    let responsePrefix = Data(
      #"{"self":{"gamesPlayed":0,"wins":0,"multiplayerGames":0,"singlePlayerGames":0,"winRate":0,"averageTotalScore":0,"bestTotalScore":null},"coPlayers":[],"recentGames":[],"admin":null}"#.utf8
    )
    let baseURL = URL(string: "https://response-boundary-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StreamingURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
    }

    let exactGeneration = StreamingURLProtocol.reset(
      totalBytes: SkyjoAPIClient.maximumResponseBytes,
      prefix: responsePrefix
    )
    let summary = try await client.statsSummary()
    #expect(summary.`self`.gamesPlayed == 0)
    #expect(StreamingURLProtocol.didFinish(exactGeneration))
    #expect(
      StreamingURLProtocol.deliveredBytes(exactGeneration)
        == SkyjoAPIClient.maximumResponseBytes
    )

    let overflowGeneration = StreamingURLProtocol.reset(
      totalBytes: SkyjoAPIClient.maximumResponseBytes + 1,
      prefix: responsePrefix
    )
    await expectError(.responseTooLarge(limit: SkyjoAPIClient.maximumResponseBytes)) {
      _ = try await client.statsSummary()
    }
    for _ in 0..<100 where !StreamingURLProtocol.wasStopped(overflowGeneration) {
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(StreamingURLProtocol.wasStopped(overflowGeneration))
  }

  @Test("Canonical HTTP fixtures decode and invalid operational fixtures fail closed")
  func canonicalHTTPFixtures() async throws {
    let decoder = JSONDecoder()
    let access = try decoder.decode(
      AccessSessionStatus.self,
      from: contractFixtureValueData(file: "http.valid.json", named: "access signed out")
    )
    #expect(!access.authenticated)

    let account = try decoder.decode(
      AccountUser.self,
      from: contractFixtureValueData(file: "http.valid.json", named: "account user", nestedKey: "user")
    )
    #expect(account.displayName == "Fixture User")
    #expect(
      try decoder.decode(
        StatsGame.self,
        from: contractFixtureValueData(
          file: "http.valid.json",
          named: "recorded stats game",
          nestedKey: "game"
        )
      ).participants.count == 2
    )
    let statsSummary = try decoder.decode(
      StatsSummary.self,
      from: contractFixtureValueData(file: "http.valid.json", named: "stats summary")
    )
    #expect(statsSummary.`self`.gamesPlayed == 1)
    #expect(
      try decoder.decode(
        PlayerStats.self,
        from: contractFixtureValueData(file: "http.valid.json", named: "player stats")
      ).user.id == account.id
    )
    #expect(
      try decoder.decode(
        ServiceReadiness.self,
        from: contractFixtureValueData(file: "http.valid.json", named: "service ready")
      ).status == .ready
    )
    #expect(
      try decoder.decode(
        ServiceVersion.self,
        from: contractFixtureValueData(file: "http.valid.json", named: "release version")
      ) == .available(
        releaseSha: "0123456789abcdef0123456789abcdef01234567",
        buildTimestamp: "2026-07-27T18:00:00.000Z",
        protocolVersion: 2
      )
    )

    expectFixtureDecodeFailure(
      AccessSessionStatus.self,
      file: "http.invalid.json",
      named: "access flag has wrong type"
    )
    expectFixtureDecodeFailure(
      StatsGame.self,
      file: "http.invalid.json",
      named: "stats game omits AI attribution"
    )
    expectFixtureDecodeFailure(
      ServiceReadiness.self,
      file: "http.invalid.json",
      named: "readiness schema is unsupported"
    )
    expectFixtureDecodeFailure(
      ServiceVersion.self,
      file: "http.invalid.json",
      named: "version timestamp is not canonical"
    )

    let accountObject = try contractFixtureValueObject(
      file: "http.valid.json",
      named: "account user",
      nestedKey: "user"
    )
    expectMissingRequiredNullableField(AccountUser.self, object: accountObject, key: "lastLoginAt")

    let gameObject = try contractFixtureValueObject(
      file: "http.valid.json",
      named: "recorded stats game",
      nestedKey: "game"
    )
    for key in ["roomCode", "winnerPlayerId", "winnerUserId", "createdByUserId"] {
      expectMissingRequiredNullableField(StatsGame.self, object: gameObject, key: key)
    }
    let participants = try #require(gameObject["participants"] as? [[String: Any]])
    expectMissingRequiredNullableField(
      StatsParticipant.self,
      object: try #require(participants.first),
      key: "userId"
    )
    let rounds = try #require(gameObject["rounds"] as? [[String: Any]])
    expectMissingRequiredNullableField(
      StatsRoundScore.self,
      object: try #require(rounds.first),
      key: "userId"
    )

    let summaryObject = try contractFixtureValueObject(
      file: "http.valid.json",
      named: "stats summary"
    )
    expectMissingRequiredNullableField(StatsSummary.self, object: summaryObject, key: "admin")
    let summaryNumbers = try #require(summaryObject["self"] as? [String: Any])
    expectMissingRequiredNullableField(
      StatsSummaryNumbers.self,
      object: summaryNumbers,
      key: "bestTotalScore"
    )
    let readinessObject = try contractFixtureValueObject(
      file: "http.valid.json",
      named: "service ready"
    )
    expectMissingRequiredNullableField(
      ServiceReadiness.self,
      object: readinessObject,
      key: "releaseSha"
    )
  }

  @Test("Account and stats DTOs enforce committed schema bounds")
  func semanticAccountAndStatsValidation() throws {
    var account = try contractFixtureValueObject(
      file: "http.valid.json",
      named: "account user",
      nestedKey: "user"
    )
    account["id"] = "10000000-0000-1000-B000-000000000001"
    account["email"] = String(repeating: "a", count: 249) + "@b.co"
    account["displayName"] = String(repeating: "N", count: 24)
    account["createdAt"] = 0
    account["updatedAt"] = 9_007_199_254_740_991
    account["lastLoginAt"] = 9_007_199_254_740_991
    _ = try decodeJSONObject(AccountUser.self, object: account)

    for (key, value) in [
      ("id", "00000000-0000-0000-0000-000000000000"),
      ("id", "10000000-0000-1000-7000-000000000001"),
      ("email", "a@b"),
      ("email", String(repeating: "a", count: 250) + "@b.co"),
      ("displayName", ""),
      ("displayName", String(repeating: "N", count: 25)),
    ] {
      expectJSONObjectDecodeFailure(AccountUser.self, object: account) { $0[key] = value }
    }
    for (key, value) in [
      ("createdAt", -1),
      ("createdAt", 9_007_199_254_740_992),
      ("updatedAt", -1),
      ("lastLoginAt", 9_007_199_254_740_992),
    ] {
      expectJSONObjectDecodeFailure(AccountUser.self, object: account) { $0[key] = value }
    }
    let game = try contractFixtureValueObject(
      file: "http.valid.json",
      named: "recorded stats game",
      nestedKey: "game"
    )
    let participants = try #require(game["participants"] as? [[String: Any]])
    var participant = try #require(participants.first)
    participant["id"] = "80000000-0000-8000-b000-000000000001"
    participant["playerId"] = String(repeating: "p", count: 128)
    participant["displayName"] = String(repeating: "P", count: 64)
    participant["rank"] = 8
    participant["roundScore"] = -1_000_000_000
    participant["totalScore"] = 1_000_000_000
    _ = try decodeJSONObject(StatsParticipant.self, object: participant)

    for (key, value) in [
      ("playerId", ""),
      ("playerId", String(repeating: "p", count: 129)),
      ("playerId", "player\u{001F}one"),
      ("playerId", "player\u{007F}one"),
      ("displayName", ""),
      ("displayName", String(repeating: "P", count: 65)),
    ] {
      expectJSONObjectDecodeFailure(StatsParticipant.self, object: participant) { $0[key] = value }
    }
    for (key, value) in [
      ("rank", 0),
      ("rank", 9),
      ("roundScore", -1_000_000_001),
      ("roundScore", 1_000_000_001),
      ("totalScore", -1_000_000_001),
      ("totalScore", 1_000_000_001),
    ] {
      expectJSONObjectDecodeFailure(StatsParticipant.self, object: participant) { $0[key] = value }
    }

    let rounds = try #require(game["rounds"] as? [[String: Any]])
    var round = try #require(rounds.first)
    round["round"] = 9_007_199_254_740_991
    round["playerId"] = String(repeating: "r", count: 128)
    round["displayName"] = String(repeating: "R", count: 64)
    round["roundScore"] = -1_000_000_000
    round["totalScore"] = 1_000_000_000
    _ = try decodeJSONObject(StatsRoundScore.self, object: round)
    for (key, value) in [
      ("round", 0),
      ("round", 9_007_199_254_740_992),
      ("roundScore", -1_000_000_001),
      ("totalScore", 1_000_000_001),
    ] {
      expectJSONObjectDecodeFailure(StatsRoundScore.self, object: round) { $0[key] = value }
    }

    let maximumGame = makeMaximumStatsGameObject()
    let decodedMaximumGame = try decodeJSONObject(StatsGame.self, object: maximumGame)
    #expect(decodedMaximumGame.participants.count == 8)
    #expect(decodedMaximumGame.rounds.count == 2_048)
    #expect(decodedMaximumGame.roundCount == 256)

    for (key, value) in [
      ("completedAt", 0),
      ("completedAt", 9_007_199_254_740_992),
      ("roundCount", 0),
      ("roundCount", 257),
    ] {
      expectJSONObjectDecodeFailure(StatsGame.self, object: game) { $0[key] = value }
    }
    for (key, value) in [
      ("roomCode", "abc12"),
      ("winnerPlayerId", "winner\u{0000}"),
      ("winnerName", ""),
      ("winnerName", String(repeating: "W", count: 65)),
    ] {
      expectJSONObjectDecodeFailure(StatsGame.self, object: game) { $0[key] = value }
    }
    expectJSONObjectDecodeFailure(StatsGame.self, object: game) { $0["participants"] = [] }
    expectJSONObjectDecodeFailure(StatsGame.self, object: game) { $0["rounds"] = [] }
    expectJSONObjectDecodeFailure(StatsGame.self, object: maximumGame) { object in
      var values = try! #require(object["participants"] as? [[String: Any]])
      values.append(values[0])
      object["participants"] = values
    }
    expectJSONObjectDecodeFailure(StatsGame.self, object: maximumGame) { object in
      var values = try! #require(object["rounds"] as? [[String: Any]])
      var extra = values[0]
      extra["id"] = "40000000-0000-4000-8000-000000009999"
      values.append(extra)
      object["rounds"] = values
    }

    let zeroSummary: [String: Any] = [
      "gamesPlayed": 0,
      "wins": 0,
      "multiplayerGames": 0,
      "singlePlayerGames": 0,
      "winRate": 0,
      "averageTotalScore": 0,
      "bestTotalScore": NSNull(),
    ]
    _ = try decodeJSONObject(StatsSummaryNumbers.self, object: zeroSummary)
    for (key, value) in [
      ("gamesPlayed", -1),
      ("wins", -1),
      ("winRate", -0.1),
      ("winRate", 100.1),
      ("bestTotalScore", 1_000_000_001),
    ] {
      expectJSONObjectDecodeFailure(StatsSummaryNumbers.self, object: zeroSummary) { $0[key] = value }
    }
    let coPlayer: [String: Any] = [
      "userId": "30000000-0000-4000-8000-000000000004",
      "displayName": String(repeating: "C", count: 24),
      "gamesTogether": 9_007_199_254_740_991,
      "wins": 9_007_199_254_740_991,
      "averageTotalScore": 1_000_000_000,
      "latestAt": 9_007_199_254_740_991,
    ]
    _ = try decodeJSONObject(StatsCoPlayer.self, object: coPlayer)
    for (key, value) in [
      ("displayName", ""),
      ("displayName", String(repeating: "C", count: 25)),
    ] {
      expectJSONObjectDecodeFailure(StatsCoPlayer.self, object: coPlayer) { $0[key] = value }
    }
    for (key, value) in [
      ("gamesTogether", 0),
      ("wins", -1),
      ("latestAt", -1),
      ("latestAt", 9_007_199_254_740_992),
    ] {
      expectJSONObjectDecodeFailure(StatsCoPlayer.self, object: coPlayer) { $0[key] = value }
    }
    let adminSummary: [String: Any] = [
      "users": 9_007_199_254_740_991,
      "games": 0,
    ]
    _ = try decodeJSONObject(StatsAdminSummary.self, object: adminSummary)
    expectJSONObjectDecodeFailure(StatsAdminSummary.self, object: adminSummary) { $0["users"] = -1 }

    let summary = try contractFixtureValueObject(file: "http.valid.json", named: "stats summary")
    var summaryWithEightGames = summary
    summaryWithEightGames["recentGames"] = (1...8).map { offset -> [String: Any] in
      var recentGame = game
      recentGame["id"] = String(format: "40000000-0000-4000-8000-%012X", 100 + offset)
      return recentGame
    }
    _ = try decodeJSONObject(StatsSummary.self, object: summaryWithEightGames)
    expectJSONObjectDecodeFailure(StatsSummary.self, object: summaryWithEightGames) { object in
      var values = try! #require(object["recentGames"] as? [[String: Any]])
      var ninth = game
      ninth["id"] = "40000000-0000-4000-8000-000000000109"
      values.append(ninth)
      object["recentGames"] = values
    }

    var additiveSummary = summary
    additiveSummary["future"] = true
    var additiveSelf = try #require(additiveSummary["self"] as? [String: Any])
    additiveSelf["future"] = "ignored"
    additiveSummary["self"] = additiveSelf
    var additiveGames = try #require(additiveSummary["recentGames"] as? [[String: Any]])
    additiveGames[0]["future"] = ["ignored": true]
    var additiveParticipants = try #require(additiveGames[0]["participants"] as? [[String: Any]])
    additiveParticipants[0]["future"] = true
    additiveGames[0]["participants"] = additiveParticipants
    var additiveRounds = try #require(additiveGames[0]["rounds"] as? [[String: Any]])
    additiveRounds[0]["future"] = true
    additiveGames[0]["rounds"] = additiveRounds
    additiveSummary["recentGames"] = additiveGames
    _ = try decodeJSONObject(StatsSummary.self, object: additiveSummary)
  }

  @Test("Unsupported operational versions become a stable upgrade error")
  func unsupportedOperationalVersion() async {
    let baseURL = URL(string: "https://upgrade-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        bodyData: try contractFixtureValueData(
          file: "http.invalid.json",
          named: "readiness schema is unsupported"
        )
      )
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    await expectError(.unsupportedServerVersion) {
      _ = try await client.readiness()
    }
  }

  @Test("Future operational axes gate version-specific fields before decoding")
  func futureOperationalAxesGateUnknownFields() async throws {
    let baseURL = URL(string: "https://future-operations-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    StubURLProtocol.install { request in
      switch request.url?.path {
      case "/readyz":
        return try stubResponse(
          for: request,
          body: #"{"status":"warming","releaseSha":{"future":true},"schemaVersion":3,"protocolVersion":3,"checks":{"database":"recovering","roomState":"future","lastPersist":"unknown"},"future":{"retryAfter":5}}"#
        )
      case "/version":
        return try stubResponse(
          for: request,
          body: #"{"status":"rolling","releaseSha":false,"buildTimestamp":42,"protocolVersion":3,"future":{"channel":"next"}}"#
        )
      default:
        throw StubError.invalidRequest
      }
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    await expectError(.unsupportedServerVersion) {
      _ = try await client.readiness()
    }
    await expectError(.unsupportedServerVersion) {
      _ = try await client.version()
    }

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        body: #"{"status":"warming","releaseSha":null,"schemaVersion":3,"protocolVersion":{"future":true},"checks":{"database":"recovering"}}"#
      )
    }
    await expectError(.unsupportedServerVersion) {
      _ = try await client.readiness()
    }

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        body: #"{"status":"warming","releaseSha":null,"schemaVersion":2,"protocolVersion":3,"checks":{"database":"recovering","roomState":"future","lastPersist":"unknown"},"future":true}"#
      )
    }
    await expectError(.unsupportedServerVersion) {
      _ = try await client.readiness()
    }

    StubURLProtocol.install { request in
      switch request.url?.path {
      case "/readyz":
        return try stubResponse(
          for: request,
          body: #"{"status":"ready","releaseSha":"development","schemaVersion":2,"protocolVersion":2,"checks":{"database":"ok","roomState":"ok","lastPersist":"ok"},"future":{"accepted":true}}"#
        )
      case "/version":
        return try stubResponse(
          for: request,
          body: #"{"releaseSha":"development","buildTimestamp":"2026-07-27T18:00:00Z","protocolVersion":2,"future":{"accepted":true}}"#
        )
      default:
        throw StubError.invalidRequest
      }
    }
    #expect(try await client.readiness().status == .ready)
    #expect(
      try await client.version()
        == .available(
          releaseSha: "development",
          buildTimestamp: "2026-07-27T18:00:00Z",
          protocolVersion: 2
        )
    )
  }

  @Test("Account requests use the typed methods and bodies")
  func accountRequests() async throws {
    let baseURL = URL(string: "https://account-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let requests = LockedValue<[String]>([])
    StubURLProtocol.install { request in
      let path = request.url?.path ?? ""
      requests.set(requests.get() + ["\(request.httpMethod ?? "") \(path)"])
      switch path {
      case "/api/account/me":
        return try stubResponse(for: request, body: #"{"user":null,"future":true}"#)
      case "/api/account/signup":
        try requireJSONBody(
          request,
          expected: [
            "email": "native@example.invalid",
            "displayName": "Native Player",
            "password": "synthetic-password",
            "confirmPassword": "synthetic-password",
          ]
        )
        return try stubResponse(for: request, statusCode: 201, body: accountUserEnvelopeJSON())
      case "/api/account/login":
        try requireJSONBody(
          request,
          expected: [
            "email": "native@example.invalid",
            "password": "synthetic-password",
          ]
        )
        return try stubResponse(for: request, body: accountUserEnvelopeJSON())
      case "/api/account/profile":
        try requireJSONBody(request, expected: ["displayName": "Native Prime"])
        return try stubResponse(for: request, body: accountUserEnvelopeJSON(displayName: "Native Prime"))
      case "/api/account/password":
        try requireJSONBody(
          request,
          expected: [
            "currentPassword": "synthetic-password",
            "password": "new-synthetic-password",
            "confirmPassword": "new-synthetic-password",
          ]
        )
        return try stubResponse(for: request, body: #"{"ok":true}"#)
      case "/api/account/logout":
        return try stubResponse(for: request, body: #"{"ok":true}"#)
      default:
        throw StubError.invalidRequest
      }
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    #expect(try await client.currentAccount() == nil)
    let signup = try await client.signup(
      email: "native@example.invalid",
      displayName: "Native Player",
      password: "synthetic-password",
      confirmPassword: "synthetic-password"
    )
    #expect(signup.displayName == "Native Player")
    #expect(
      try await client.loginAccount(
        email: "native@example.invalid",
        password: "synthetic-password"
      ).id == signup.id
    )
    #expect(try await client.updateProfile(displayName: "Native Prime").displayName == "Native Prime")
    try await client.changePassword(
      currentPassword: "synthetic-password",
      password: "new-synthetic-password",
      confirmPassword: "new-synthetic-password"
    )
    try await client.logoutAccount()

    #expect(requests.get() == [
      "GET /api/account/me",
      "POST /api/account/signup",
      "POST /api/account/login",
      "PATCH /api/account/profile",
      "POST /api/account/password",
      "POST /api/account/logout",
    ])
  }

  @Test("Required nullable account fields reject omission")
  func missingAccountEnvelopeUser() async {
    let baseURL = URL(string: "https://account-shape-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    StubURLProtocol.install { request in
      try stubResponse(for: request, body: #"{}"#)
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    await expectError(.invalidSuccessPayload) {
      _ = try await client.currentAccount()
    }
  }

  @Test("Stats, readiness, and player history decode typed additive responses")
  func statsAndOperationalResponses() async throws {
    let baseURL = URL(string: "https://stats-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let gameID = "40000000-0000-4000-8000-000000000001"
    let userID = "30000000-0000-4000-8000-000000000003"
    StubURLProtocol.install { request in
      switch request.url?.path {
      case "/readyz":
        return try stubResponse(
          for: request,
          statusCode: 503,
          body: #"{"status":"not_ready","releaseSha":null,"schemaVersion":2,"protocolVersion":2,"checks":{"database":"ok","roomState":"error","lastPersist":"ok"}}"#
        )
      case "/version":
        return try stubResponse(for: request, statusCode: 503, body: #"{"status":"unavailable"}"#)
      case "/api/stats/summary":
        return try stubResponse(
          for: request,
          body: "{\"self\":\(statsSummaryNumbersJSON()),\"coPlayers\":[],\"recentGames\":[\(statsGameJSON())],\"admin\":null,\"future\":true}"
        )
      case "/api/stats/games":
        return try stubResponse(for: request, body: "{\"games\":[\(statsGameJSON())]}")
      case "/api/stats/games/\(gameID)":
        return try stubResponse(for: request, body: "{\"game\":\(statsGameJSON())}")
      case "/api/stats/players/\(userID)":
        return try stubResponse(
          for: request,
          body: "{\"user\":\(accountUserJSON()),\"summary\":\(statsSummaryNumbersJSON()),\"games\":[\(statsGameJSON())]}"
        )
      default:
        throw StubError.invalidRequest
      }
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    #expect(try await client.readiness().status == .notReady)
    #expect(try await client.version() == .unavailable)
    #expect(try await client.statsSummary().recentGames.count == 1)
    #expect(try await client.statsGames().first?.winnerName == "Fixture User")
    let parsedGameID = try #require(UUID(uuidString: gameID))
    #expect(try await client.statsGame(id: parsedGameID).id == parsedGameID)
    let parsedUserID = try #require(UUID(uuidString: userID))
    #expect(try await client.playerStats(userID: parsedUserID).user.id == parsedUserID)
  }

  @Test("Single-player stats uses the exact idempotent POST contract and requires a single-game 201")
  func singlePlayerStatsSubmissionContract() async throws {
    let baseURL = URL(string: "https://solo-stats-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let gameID = UUID(uuidString: "40000000-0000-4000-8000-000000000187")!
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000003")!
    let completedAt: Int64 = 1_784_998_800_000
    var random = SeededRandom(seed: 187)
    let state = GameEngine.startFreshGame(aiOpponentCount: 1, random: &random)
    let requestWasExact = LockedValue(false)

    StubURLProtocol.install { request in
      guard
        request.httpMethod == "POST",
        request.url?.path == "/api/stats/single-player",
        request.value(forHTTPHeaderField: "Accept") == "application/json",
        request.value(forHTTPHeaderField: "Content-Type") == "application/json; charset=utf-8",
        let body = requestBody(request),
        let payload = try JSONSerialization.jsonObject(with: body) as? [String: Any],
        Set(payload.keys) == ["state", "clientGameKey", "completedAt", "expectedAccountUserId"],
        payload["clientGameKey"] as? String == gameID.uuidString.lowercased(),
        (payload["completedAt"] as? NSNumber)?.int64Value == completedAt,
        payload["expectedAccountUserId"] as? String == accountID.uuidString.lowercased(),
        payload["state"] is [String: Any]
      else { throw StubError.invalidRequest }
      requestWasExact.set(true)
      return try stubResponse(
        for: request,
        statusCode: 201,
        body: "{\"game\":\(statsGameJSON())}"
      )
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    let submission = SinglePlayerStatsSubmission(
      state: state,
      clientGameID: gameID,
      completedAt: completedAt,
      expectedAccountUserID: accountID
    )
    let result = try await client.submitSinglePlayerStats(submission)
    #expect(requestWasExact.get())
    #expect(result.mode == .single)

    StubURLProtocol.install { request in
      let multiGame = statsGameJSON().replacingOccurrences(
        of: #""mode":"single""#,
        with: #""mode":"multi""#
      )
      return try stubResponse(
        for: request,
        statusCode: 201,
        body: "{\"game\":\(multiGame)}"
      )
    }
    await expectError(.invalidSuccessPayload) {
      _ = try await client.submitSinglePlayerStats(submission)
    }
  }

  @Test("Solo stats delivery permanently classifies body errors and fences authorization changes")
  func soloStatsDeliveryClassification() async throws {
    let baseURL = URL(string: "https://solo-delivery-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let gameID = UUID(uuidString: "40000000-0000-4000-8000-000000000187")!
    let accountID = UUID(uuidString: "30000000-0000-4000-8000-000000000003")!
    var random = SeededRandom(seed: 187)
    let state = GameEngine.startFreshGame(aiOpponentCount: 1, random: &random)
    let submission = SinglePlayerStatsSubmission(
      state: state,
      clientGameID: gameID,
      completedAt: 1_784_998_800_000,
      expectedAccountUserID: accountID
    )
    let request = try JSONDecoder().decode(
      StatsSubmissionRequest.self,
      from: JSONEncoder().encode(submission)
    )
    let invalidationReason = LockedValue<SessionInvalidationRelay.Reason?>(nil)
    let authorizationFence = SessionInvalidationRelay.AuthorizationFence(
      accountID: accountID,
      generation: 1
    )
    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 413,
        body: #"{"code":"REQUEST_TOO_LARGE","error":"Request body is too large."}"#
      )
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    let adapter = SoloStatsDeliveryAdapter(
      client: client,
      authorizationFence: { requestedAccountID in
        requestedAccountID == accountID ? authorizationFence : nil
      },
      invalidateAuthorization: { reason, receivedFence in
        #expect(receivedFence == authorizationFence)
        invalidationReason.set(reason)
      }
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    do {
      try await adapter.deliver(request)
      Issue.record("Expected request-too-large to fail permanently.")
    } catch let error as StatsDeliveryError {
      #expect(error == .permanent(.requestTooLarge))
    }
    #expect(invalidationReason.get() == nil)

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 401,
        body: #"{"code":"ACCOUNT_SESSION_CHANGED","error":"Account session changed."}"#
      )
    }
    do {
      try await adapter.deliver(request)
      Issue.record("Expected account-session change to abort delivery.")
    } catch let error as StatsDeliveryError {
      #expect(error == .authorizationChanged)
    }
    #expect(invalidationReason.get() == .accountSessionChanged)

    invalidationReason.set(nil)
    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 401,
        body: #"{"code":"ACCESS_REQUIRED","error":"Enter the site password."}"#
      )
    }
    do {
      try await adapter.deliver(request)
      Issue.record("Expected outer-access loss to abort delivery.")
    } catch let error as StatsDeliveryError {
      #expect(error == .authorizationChanged)
    }
    #expect(invalidationReason.get() == .accessRequired)
  }

  @Test("Stats detail endpoints reject mismatched response identities")
  func statsDetailIdentityMismatch() async throws {
    let baseURL = URL(string: "https://stats-identity-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    let requestedGameID = try #require(UUID(uuidString: "40000000-0000-4000-8000-000000000001"))
    let requestedUserID = try #require(UUID(uuidString: "30000000-0000-4000-8000-000000000003"))
    let otherUserID = "30000000-0000-4000-8000-000000000099"
    StubURLProtocol.install { request in
      switch request.url?.path {
      case "/api/stats/games/\(requestedGameID.uuidString.lowercased())":
        let wrongGame = statsGameJSON().replacingOccurrences(
          of: "40000000-0000-4000-8000-000000000001",
          with: "40000000-0000-4000-8000-000000000099"
        )
        return try stubResponse(for: request, body: "{\"game\":\(wrongGame)}")
      case "/api/stats/players/\(requestedUserID.uuidString.lowercased())":
        let wrongUser = accountUserJSON().replacingOccurrences(
          of: requestedUserID.uuidString.lowercased(),
          with: otherUserID.lowercased()
        )
        let wrongGame = statsGameJSON().replacingOccurrences(
          of: requestedUserID.uuidString.lowercased(),
          with: otherUserID.lowercased()
        )
        return try stubResponse(
          for: request,
          body: "{\"user\":\(wrongUser),\"summary\":\(statsSummaryNumbersJSON()),\"games\":[\(wrongGame)]}"
        )
      default:
        throw StubError.invalidRequest
      }
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    await expectError(.invalidSuccessPayload) {
      _ = try await client.statsGame(id: requestedGameID)
    }
    await expectError(.invalidSuccessPayload) {
      _ = try await client.playerStats(userID: requestedUserID)
    }
  }

  @Test("Protected routes preserve stable errors and hide unknown detail")
  func safeErrors() async {
    let baseURL = URL(string: "https://errors-\(UUID().uuidString).test")!
    let cookieStorage = testCookieStorage(for: baseURL)
    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 401,
        body: #"{"code":"ACCOUNT_AUTHENTICATION_REQUIRED","error":"Sign in to your Skyjo account."}"#
      )
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [StubURLProtocol.self]
    )
    let client = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
      StubURLProtocol.removeHandler()
    }

    await expectError(
      .server(
        statusCode: 401,
        code: .accountAuthenticationRequired,
        message: "Sign in to your Skyjo account."
      )
    ) {
      _ = try await client.statsGames()
    }

    StubURLProtocol.install { request in
      try stubResponse(
        for: request,
        statusCode: 500,
        body: #"{"code":"FUTURE_PRIVATE_DETAIL","error":"Do not display this detail."}"#
      )
    }
    await expectError(
      .server(
        statusCode: 500,
        code: SkyjoAPIErrorCode(rawValue: "FUTURE_PRIVATE_DETAIL"),
        message: SkyjoHTTPClientError.safeFallbackMessage
      )
    ) {
      _ = try await client.statsSummary()
    }
  }
}

@Suite("Access session local Node contract", .serialized)
struct AccessSessionNodeIntegrationTests {
  private let syntheticAccessPassword = "skyjo-ios-contract-access-v1"

  @Test("URLSession persists outer access and logout clears both cookie layers")
  func cookieRoundTrip() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard
      let rawBaseURL = environment["SKYJO_IOS_TEST_SERVER_URL"],
      let baseURL = URL(string: rawBaseURL)
    else {
      Issue.record("Run this suite through scripts/ios-build-test.sh so the isolated Node server is available.")
      return
    }

    let cookieStorage = testCookieStorage(for: baseURL)
    let session = SkyjoURLSessionFactory.makeDedicated(cookieStorage: cookieStorage)
    let client = AccessSessionClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session,
      cookieStorage: cookieStorage
    )
    defer {
      session.invalidateAndCancel()
      clearCookies(cookieStorage, for: baseURL)
    }

    #expect(try await client.status() == AccessSessionStatus(authenticated: false))

    await expectError(
      .server(
        statusCode: 401,
        code: .accessAuthenticationFailed,
        message: "Authentication failed."
      )
    ) {
      _ = try await client.login(password: "incorrect-\(syntheticAccessPassword.count)")
    }
    #expect(cookieNames(in: cookieStorage, for: baseURL).isEmpty)

    #expect(
      try await client.login(password: syntheticAccessPassword)
        == AccessSessionStatus(authenticated: true)
    )
    #expect(try await client.status() == AccessSessionStatus(authenticated: true))
    #expect(cookieNames(in: cookieStorage, for: baseURL).contains("skyjo_session"))

    let accountCookieHost = try #require(baseURL.host)
    let accountCookie = try #require(HTTPCookie(properties: [
      .domain: accountCookieHost,
      .name: "skyjo_account",
      .path: "/",
      .value: "synthetic-test-cookie",
    ]))
    cookieStorage.setCookie(accountCookie)
    #expect(cookieNames(in: cookieStorage, for: baseURL).contains("skyjo_account"))

    #expect(try await client.logout() == AccessSessionStatus(authenticated: false))
    let namesAfterLogout = cookieNames(in: cookieStorage, for: baseURL)
    #expect(!namesAfterLogout.contains("skyjo_session"))
    #expect(!namesAfterLogout.contains("skyjo_account"))
    #expect(try await client.status() == AccessSessionStatus(authenticated: false))
    #expect(try await client.logout() == AccessSessionStatus(authenticated: false))
  }

  @Test("Two cookie layers survive client recreation and protect the complete account and stats flow")
  func accountStatsRoundTripAcrossRelaunchSimulation() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard
      let rawBaseURL = environment["SKYJO_IOS_TEST_SERVER_URL"],
      let baseURL = URL(string: rawBaseURL)
    else {
      Issue.record("Run this suite through scripts/ios-build-test.sh so the isolated Node server is available.")
      return
    }

    let cookieStorage = testCookieStorage(for: baseURL)
    let firstSession = SkyjoURLSessionFactory.makeDedicated(cookieStorage: cookieStorage)
    let firstClient = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: firstSession
    )
    defer { clearCookies(cookieStorage, for: baseURL) }

    #expect(try await firstClient.readiness().status == .ready)
    #expect(
      try await firstClient.loginAccess(password: syntheticAccessPassword)
        == AccessSessionStatus(authenticated: true)
    )

    let accountPassword = "native-account-password-v1"
    let replacementPassword = "native-account-password-v2"
    let email = "ios-\(UUID().uuidString.lowercased())@example.invalid"
    let createdUser = try await firstClient.signup(
      email: email,
      displayName: "Native Player",
      password: accountPassword,
      confirmPassword: accountPassword
    )
    #expect(cookieNames(in: cookieStorage, for: baseURL).isSuperset(of: ["skyjo_session", "skyjo_account"]))

    firstSession.invalidateAndCancel()
    let relaunchedSession = SkyjoURLSessionFactory.makeDedicated(cookieStorage: cookieStorage)
    let relaunchedClient = SkyjoAPIClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: relaunchedSession
    )
    defer { relaunchedSession.invalidateAndCancel() }

    #expect(try await relaunchedClient.accessStatus().authenticated)
    #expect(try await relaunchedClient.currentAccount()?.id == createdUser.id)
    #expect(try await relaunchedClient.updateProfile(displayName: "Native Prime").displayName == "Native Prime")
    #expect(try await relaunchedClient.statsSummary().`self`.gamesPlayed == 0)
    #expect(try await relaunchedClient.statsGames().isEmpty)

    try await saveSyntheticSoloGame(
      session: relaunchedSession,
      baseURL: baseURL,
      userID: createdUser.id
    )
    let summary = try await relaunchedClient.statsSummary()
    #expect(summary.`self`.gamesPlayed == 1)
    let games = try await relaunchedClient.statsGames()
    let game = try #require(games.first)
    #expect(try await relaunchedClient.statsGame(id: game.id).id == game.id)
    let playerHistory = try await relaunchedClient.playerStats(userID: createdUser.id)
    #expect(playerHistory.user.id == createdUser.id)
    #expect(playerHistory.games.map(\.id).contains(game.id))

    try await relaunchedClient.changePassword(
      currentPassword: accountPassword,
      password: replacementPassword,
      confirmPassword: replacementPassword
    )
    #expect(try await relaunchedClient.currentAccount() == nil)
    #expect(
      try await relaunchedClient.loginAccount(email: email, password: replacementPassword).id
        == createdUser.id
    )
    try await relaunchedClient.logoutAccount()
    #expect(try await relaunchedClient.currentAccount() == nil)
    #expect(try await relaunchedClient.accessStatus().authenticated)
  }
}

private struct ClientFixture {
  let client: AccessSessionClient
  let session: URLSession
  let cookieStorage: HTTPCookieStorage
  let cookieURL: URL

  func dispose() {
    session.invalidateAndCancel()
    clearCookies(cookieStorage, for: cookieURL)
    StubURLProtocol.removeHandler()
  }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)

  private static let handler = LockedValue<Handler?>(nil)

  static func install(_ handler: @escaping Handler) {
    Self.handler.set(handler)
  }

  static func removeHandler() {
    handler.set(nil)
  }

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    guard let handler = Self.handler.get() else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }

    do {
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

private final class StreamingURLProtocol: URLProtocol, @unchecked Sendable {
  private static let configuration = LockedValue(
    StreamingResponseConfiguration(generation: 0, totalBytes: 0, prefix: Data())
  )
  private static let delivery = LockedValue(
    StreamingDeliveryState(generation: 0, count: 0)
  )
  private static let stoppedGeneration = LockedValue<Int?>(nil)
  private static let finishedGeneration = LockedValue<Int?>(nil)

  private let deliveryQueue = DispatchQueue(label: "com.groundworkrevops.skyjo.tests.stream")
  private var generation = 0
  private var totalBytes = 0
  private var prefix = Data()

  static func reset(totalBytes: Int, prefix: Data = Data()) -> Int {
    let generation = configuration.get().generation + 1
    configuration.set(
      StreamingResponseConfiguration(
        generation: generation,
        totalBytes: totalBytes,
        prefix: prefix
      )
    )
    delivery.set(StreamingDeliveryState(generation: generation, count: 0))
    stoppedGeneration.set(nil)
    finishedGeneration.set(nil)
    return generation
  }

  static func deliveredBytes(_ generation: Int) -> Int {
    let state = delivery.get()
    return state.generation == generation ? state.count : 0
  }

  static func wasStopped(_ generation: Int) -> Bool {
    stoppedGeneration.get() == generation
  }

  static func didFinish(_ generation: Int) -> Bool {
    finishedGeneration.get() == generation
  }

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    let configuration = Self.configuration.get()
    generation = configuration.generation
    totalBytes = configuration.totalBytes
    prefix = configuration.prefix
    guard
      let url = request.url,
      let response = HTTPURLResponse(
        url: url,
        statusCode: 200,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json; charset=utf-8"]
      )
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }

    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    scheduleNextChunk()
  }

  override func stopLoading() {
    guard Self.configuration.get().generation == generation else { return }
    Self.stoppedGeneration.set(generation)
  }

  private func scheduleNextChunk() {
    let workItem = DispatchWorkItem { [weak self] in
      guard
        let self,
        Self.configuration.get().generation == self.generation,
        !Self.wasStopped(self.generation)
      else { return }
      let delivered = Self.deliveredBytes(self.generation)
      guard delivered < self.totalBytes else {
        Self.finishedGeneration.set(self.generation)
        self.client?.urlProtocolDidFinishLoading(self)
        return
      }

      let chunkSize = min(4_096, self.totalBytes - delivered)
      var chunk = Data(repeating: 0x20, count: chunkSize)
      if delivered < self.prefix.count {
        let prefixEnd = min(self.prefix.count, delivered + chunkSize)
        chunk.replaceSubrange(
          0..<(prefixEnd - delivered),
          with: self.prefix[delivered..<prefixEnd]
        )
      }
      Self.delivery.set(
        StreamingDeliveryState(generation: self.generation, count: delivered + chunkSize)
      )
      self.client?.urlProtocol(self, didLoad: chunk)
      self.scheduleNextChunk()
    }
    deliveryQueue.asyncAfter(deadline: .now() + .milliseconds(2), execute: workItem)
  }
}

private struct StreamingResponseConfiguration: Sendable {
  let generation: Int
  let totalBytes: Int
  let prefix: Data
}

private struct StreamingDeliveryState: Sendable {
  let generation: Int
  let count: Int
}

private final class LockedValue<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value

  init(_ value: Value) {
    self.value = value
  }

  func get() -> Value {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func set(_ value: Value) {
    lock.lock()
    defer { lock.unlock() }
    self.value = value
  }
}

private enum StubError: Error {
  case invalidRequest
}

private func contractFixtureValueData(
  file: String,
  named caseName: String,
  nestedKey: String? = nil
) throws -> Data {
  let value = try contractFixtureValueObject(file: file, named: caseName, nestedKey: nestedKey)
  return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

private func contractFixtureValueObject(
  file: String,
  named caseName: String,
  nestedKey: String? = nil
) throws -> [String: Any] {
  let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
  let fixtureURL = repositoryRoot
    .appending(path: "contracts/v1/fixtures")
    .appending(path: file)
  let fixtureData = try Data(contentsOf: fixtureURL)
  guard
    let root = try JSONSerialization.jsonObject(with: fixtureData) as? [String: Any],
    let cases = root["cases"] as? [[String: Any]],
    let fixtureCase = cases.first(where: { $0["name"] as? String == caseName }),
    var value = fixtureCase["value"]
  else {
    throw StubError.invalidRequest
  }
  if let nestedKey {
    guard let object = value as? [String: Any], let nestedValue = object[nestedKey] else {
      throw StubError.invalidRequest
    }
    value = nestedValue
  }
  guard let object = value as? [String: Any], JSONSerialization.isValidJSONObject(object) else {
    throw StubError.invalidRequest
  }
  return object
}

private func expectFixtureDecodeFailure<Value: Decodable>(
  _ type: Value.Type,
  file: String,
  named caseName: String
) {
  let data: Data
  do {
    data = try contractFixtureValueData(file: file, named: caseName)
  } catch {
    Issue.record("Could not load contract fixture '\(caseName)': \(error)")
    return
  }

  do {
    _ = try JSONDecoder().decode(type, from: data)
    Issue.record("Expected contract fixture '\(caseName)' to fail decoding.")
  } catch {
    // Expected: this fixture is intentionally contract-invalid.
  }
}

private func expectMissingRequiredNullableField<Value: Decodable>(
  _ type: Value.Type,
  object: [String: Any],
  key: String
) {
  var missingKeyObject = object
  guard missingKeyObject.removeValue(forKey: key) != nil else {
    Issue.record("Canonical fixture does not contain required nullable key '\(key)'.")
    return
  }

  do {
    let data = try JSONSerialization.data(withJSONObject: missingKeyObject, options: [.sortedKeys])
    _ = try JSONDecoder().decode(type, from: data)
    Issue.record("Expected missing required nullable key '\(key)' to fail decoding.")
  } catch {
    // Expected: null is valid for this key, but omission is not.
  }
}

private func decodeJSONObject<Value: Decodable>(
  _ type: Value.Type,
  object: [String: Any]
) throws -> Value {
  let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  return try JSONDecoder().decode(type, from: data)
}

private func expectJSONObjectDecodeFailure<Value: Decodable>(
  _ type: Value.Type,
  object: [String: Any],
  mutate: (inout [String: Any]) -> Void
) {
  var invalidObject = object
  mutate(&invalidObject)
  do {
    _ = try decodeJSONObject(type, object: invalidObject)
    Issue.record("Expected semantic contract validation to reject the payload.")
  } catch {
    // Expected: this mutation violates a committed DTO bound or relationship.
  }
}

private func makeMaximumStatsGameObject() -> [String: Any] {
  let userID = "30000000-0000-4000-8000-000000000003"
  var participants: [[String: Any]] = []
  for offset in 1...8 {
    participants.append([
      "id": String(format: "40000000-0000-4000-8000-%012X", offset),
      "userId": offset == 1 ? userID : NSNull(),
      "playerId": String(repeating: "p", count: 127) + String(offset),
      "displayName": String(repeating: "P", count: 63) + String(offset),
      "kind": offset == 1 ? "human" : "ai",
      "rank": offset,
      "roundScore": offset == 1 ? -1_000_000_000 : 1_000_000_000,
      "totalScore": offset == 1 ? -1_000_000_000 : 1_000_000_000,
      "won": offset == 1,
    ])
  }

  var rounds: [[String: Any]] = []
  for round in 1...256 {
    for offset in 1...8 {
      rounds.append([
        "id": String(
          format: "50000000-0000-4000-8000-%012X",
          (round - 1) * 8 + offset
        ),
        "round": round,
        "playerId": String(repeating: "p", count: 127) + String(offset),
        "userId": offset == 1 ? userID : NSNull(),
        "displayName": String(repeating: "P", count: 63) + String(offset),
        "roundScore": offset == 1 ? -1_000_000_000 : 1_000_000_000,
        "totalScore": offset == 1 ? -1_000_000_000 : 1_000_000_000,
      ])
    }
  }

  return [
    "id": "60000000-0000-4000-8000-000000000001",
    "mode": "multi",
    "roomCode": "A1B2C",
    "completedAt": 9_007_199_254_740_991,
    "roundCount": 256,
    "winnerPlayerId": String(repeating: "p", count: 127) + "1",
    "winnerName": String(repeating: "P", count: 63) + "1",
    "winnerUserId": userID,
    "createdByUserId": userID,
    "finishedByAi": true,
    "participants": participants,
    "rounds": rounds,
  ]
}

private func requireJSONBody(_ request: URLRequest, expected: [String: String]) throws {
  guard
    request.value(forHTTPHeaderField: "Content-Type") == "application/json; charset=utf-8",
    request.value(forHTTPHeaderField: "Accept") == "application/json",
    let data = requestBody(request),
    let value = try JSONSerialization.jsonObject(with: data) as? [String: String],
    value == expected
  else {
    throw StubError.invalidRequest
  }
}

private func accountUserEnvelopeJSON(displayName: String = "Native Player") -> String {
  "{\"user\":\(accountUserJSON(displayName: displayName)),\"future\":true}"
}

private func accountUserJSON(displayName: String = "Fixture User") -> String {
  """
  {
    "id":"30000000-0000-4000-8000-000000000003",
    "email":"native@example.invalid",
    "displayName":"\(displayName)",
    "role":"player",
    "disabled":false,
    "createdAt":1784998800104,
    "updatedAt":1784998800104,
    "lastLoginAt":null
  }
  """
}

private func statsSummaryNumbersJSON() -> String {
  """
  {
    "gamesPlayed":1,
    "wins":1,
    "multiplayerGames":0,
    "singlePlayerGames":1,
    "winRate":100,
    "averageTotalScore":22,
    "bestTotalScore":22
  }
  """
}

private func statsGameJSON() -> String {
  """
  {
    "id":"40000000-0000-4000-8000-000000000001",
    "mode":"single",
    "roomCode":null,
    "completedAt":1784998800000,
    "roundCount":1,
    "winnerPlayerId":"human-1",
    "winnerName":"Fixture User",
    "winnerUserId":"30000000-0000-4000-8000-000000000003",
    "createdByUserId":"30000000-0000-4000-8000-000000000003",
    "finishedByAi":false,
    "participants":[{
      "id":"40000000-0000-4000-8000-000000000002",
      "userId":"30000000-0000-4000-8000-000000000003",
      "playerId":"human-1",
      "displayName":"Fixture User",
      "kind":"human",
      "rank":1,
      "roundScore":22,
      "totalScore":22,
      "won":true
    }],
    "rounds":[{
      "id":"40000000-0000-4000-8000-000000000003",
      "round":1,
      "playerId":"human-1",
      "userId":"30000000-0000-4000-8000-000000000003",
      "displayName":"Fixture User",
      "roundScore":22,
      "totalScore":22
    }]
  }
  """
}

private func saveSyntheticSoloGame(
  session: URLSession,
  baseURL: URL,
  userID: UUID
) async throws {
  let state: [String: Any] = [
    "players": [
      [
        "id": "human-1",
        "kind": "human",
        "name": "Native Prime",
        "grid": [],
        "totalScore": 22,
        "roundScore": 8,
      ],
      [
        "id": "ai-1",
        "kind": "ai",
        "name": "Finn",
        "grid": [],
        "totalScore": 44,
        "roundScore": 17,
      ],
    ],
    "drawPile": [],
    "discardPile": [],
    "currentPlayerIndex": 0,
    "phase": "game-over",
    "selectedSource": NSNull(),
    "drawnCard": NSNull(),
    "round": 2,
    "log": ["Native Prime wins."],
    "winnerId": "human-1",
    "nextStarterId": NSNull(),
    "roundCloserId": NSNull(),
    "finalTurnPlayerIds": [],
    "openingRevealCounts": ["human-1": 2, "ai-1": 2],
    "roundHistory": [
      [
        "round": 1,
        "closerId": "human-1",
        "scores": [
          ["playerId": "human-1", "name": "Native Prime", "roundScore": 14, "totalScore": 14],
          ["playerId": "ai-1", "name": "Finn", "roundScore": 27, "totalScore": 27],
        ],
      ],
      [
        "round": 2,
        "closerId": "ai-1",
        "scores": [
          ["playerId": "human-1", "name": "Native Prime", "roundScore": 8, "totalScore": 22],
          ["playerId": "ai-1", "name": "Finn", "roundScore": 17, "totalScore": 44],
        ],
      ],
    ],
  ]
  let stateData = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
  let gameState = try JSONDecoder().decode(GameState.self, from: stateData)
  let client = SkyjoAPIClient(
    environment: SkyjoNetworkEnvironment(baseURL: baseURL),
    session: session
  )
  let saved = try await client.submitSinglePlayerStats(
    SinglePlayerStatsSubmission(
      state: gameState,
      clientGameID: UUID(),
      completedAt: 1_784_998_800_000,
      expectedAccountUserID: userID
    )
  )
  #expect(saved.mode == .single)
}

private func requestBody(_ request: URLRequest) -> Data? {
  if let body = request.httpBody {
    return body
  }
  guard let stream = request.httpBodyStream else {
    return nil
  }

  stream.open()
  defer { stream.close() }

  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 4_096)
  while true {
    let count = stream.read(&buffer, maxLength: buffer.count)
    guard count >= 0 else {
      return nil
    }
    if count == 0 {
      break
    }
    data.append(contentsOf: buffer.prefix(count))
  }
  return data
}

private func stubResponse(
  for request: URLRequest,
  statusCode: Int = 200,
  body: String,
  contentType: String = "application/json; charset=utf-8",
  additionalHeaders: [String: String] = [:]
) throws -> (HTTPURLResponse, Data) {
  try stubResponse(
    for: request,
    statusCode: statusCode,
    bodyData: Data(body.utf8),
    contentType: contentType,
    additionalHeaders: additionalHeaders
  )
}

private func stubResponse(
  for request: URLRequest,
  statusCode: Int = 200,
  bodyData: Data,
  contentType: String = "application/json; charset=utf-8",
  additionalHeaders: [String: String] = [:]
) throws -> (HTTPURLResponse, Data) {
  var headers = additionalHeaders
  headers["Content-Type"] = contentType
  let responseURL = try #require(request.url)
  let response = try #require(HTTPURLResponse(
    url: responseURL,
    statusCode: statusCode,
    httpVersion: "HTTP/1.1",
    headerFields: headers
  ))
  return (response, bodyData)
}

private func expectError(
  _ expected: SkyjoHTTPClientError,
  operation: () async throws -> Void
) async {
  do {
    try await operation()
    Issue.record("Expected the HTTP operation to fail.")
  } catch let error as SkyjoHTTPClientError {
    #expect(error == expected)
  } catch {
    Issue.record("The HTTP operation failed with an unexpected error type.")
  }
}

private func testCookieStorage(for url: URL) -> HTTPCookieStorage {
  let storage = HTTPCookieStorage.shared
  clearCookies(storage, for: url)
  return storage
}

private func cookieNames(in storage: HTTPCookieStorage, for url: URL) -> Set<String> {
  Set((storage.cookies(for: url) ?? []).map(\.name))
}

private func clearCookies(_ storage: HTTPCookieStorage, for url: URL) {
  for cookie in storage.cookies(for: url) ?? [] {
    storage.deleteCookie(cookie)
  }
}

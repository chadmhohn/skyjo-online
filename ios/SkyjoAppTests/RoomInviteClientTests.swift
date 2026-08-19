import Foundation
import SkyjoNetworking
import Testing

private let inviteTestNowMilliseconds: Int64 = 1_800_000_000_000
private let inviteTestExpiresAtMilliseconds: Int64 = 1_800_003_600_000

@Suite("Room invites and seat recovery", .serialized)
struct RoomInviteClientTests {
  private let productionInviteToken = "signed_payload.signature_123"
  private let productionInviteURL = URL(
    string: "https://skyjo.groundworkrevops.com/invite/signed_payload.signature_123"
  )!
  private let expiresAt = inviteTestExpiresAtMilliseconds

  @Test("The app entitlement declares the exact production universal-link domain")
  func associatedDomainsEntitlement() throws {
    let repositoryRoot = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let entitlementURL = repositoryRoot
      .appending(path: "ios/SkyjoApp/Resources/SkyjoNative.entitlements")
    let data = try Data(contentsOf: entitlementURL)
    let value = try #require(
      try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    )
    let domains = try #require(
      value["com.apple.developer.associated-domains"] as? [String]
    )
    #expect(domains == ["applinks:skyjo.groundworkrevops.com"])
  }

  @Test("Production invite links and tokens reject every ambiguous URL shape")
  func strictProductionInviteLinkParsing() throws {
    let link = try RoomInviteLink(url: productionInviteURL)
    #expect(link.token == (try RoomInviteToken(productionInviteToken)))

    let maximumToken = String(repeating: "a", count: 1_023)
      + "."
      + String(repeating: "b", count: 1_024)
    #expect(maximumToken.unicodeScalars.count == 2_048)
    _ = try RoomInviteToken(maximumToken)

    for rawURL in [
      "http://skyjo.groundworkrevops.com/invite/a.b",
      "https://example.invalid/invite/a.b",
      "https://skyjo.groundworkrevops.com.evil.invalid/invite/a.b",
      "https://user@skyjo.groundworkrevops.com/invite/a.b",
      "https://skyjo.groundworkrevops.com:443/invite/a.b",
      "https://skyjo.groundworkrevops.com/invite/a.b?open=browser",
      "https://skyjo.groundworkrevops.com/invite/a.b#fragment",
      "https://skyjo.groundworkrevops.com/invite/",
      "https://skyjo.groundworkrevops.com/invite/a.b/extra",
      "https://skyjo.groundworkrevops.com/invite/a%2Eb",
      "https://skyjo.groundworkrevops.com/other/a.b",
    ] {
      let url = try #require(URL(string: rawURL))
      #expect(throws: RoomInviteContractError.invalidInviteURL) {
        _ = try RoomInviteLink(url: url)
      }
    }

    for token in [
      "",
      "missing-separator",
      ".missing-prefix",
      "missing-suffix.",
      "too.many.separators",
      "invalid+.signature",
      "private🃏.signature",
      maximumToken + "c",
    ] {
      #expect(throws: RoomInviteContractError.invalidInviteToken) {
        _ = try RoomInviteToken(token)
      }
    }
  }

  @Test("Invite and seat values remain redacted in printable representations")
  func sensitiveValueRedaction() throws {
    let token = try RoomInviteToken(productionInviteToken)
    let link = try RoomInviteLink(url: productionInviteURL)
    let redeemed = try RedeemedRoomInvite(roomCode: "A1B2C", expiresAt: expiresAt)
    let seat = try RoomSeatRecoveryRecord(
      accountID: try #require(UUID(uuidString: "30000000-0000-4000-8000-000000000003")),
      roomCode: "A1B2C",
      playerID: "private-seat-id"
    )

    for rendered in [
      String(describing: token),
      String(reflecting: token),
      String(describing: link),
      String(reflecting: link),
      String(describing: redeemed),
      String(reflecting: redeemed),
      String(describing: seat),
      String(reflecting: seat),
    ] {
      #expect(!rendered.contains(productionInviteToken))
      #expect(!rendered.contains("A1B2C"))
      #expect(!rendered.contains("private-seat-id"))
      #expect(!rendered.contains(String(expiresAt)))
      #expect(!rendered.contains("skyjo.groundworkrevops.com"))
    }
  }

  @Test("Redemption persists outer access for a separate cookie-sharing session")
  func exactRedemptionRequestAndCookie() async throws {
    let requestWasExact = InviteLockedValue(false)
    let fixture = makeInviteFixture { [productionInviteToken, expiresAt] request in
      let body = try #require(inviteRequestBody(request))
      let object = try #require(
        JSONSerialization.jsonObject(with: body) as? [String: String]
      )
      requestWasExact.set(
        request.httpMethod == "POST"
          && request.url?.path == "/api/rooms/invite/redeem"
          && request.url?.query == nil
          && request.url?.fragment == nil
          && request.cachePolicy == .reloadIgnoringLocalCacheData
          && request.value(forHTTPHeaderField: "Accept") == "application/json"
          && request.value(forHTTPHeaderField: "Content-Type") == "application/json; charset=utf-8"
          && Set(object.keys) == ["token"]
          && object["token"] == productionInviteToken
          && request.value(forHTTPHeaderField: "Cookie")?.contains(
            "skyjo_account=existing-account-session"
          ) == true
          && body.count <= RoomInviteClient.maximumRequestBytes
      )
      return try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":\#(expiresAt)}"#,
        headers: [
          "Cache-Control": "private, no-store",
          "Set-Cookie": "skyjo_session=outer-access-fixture; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
        ]
      )
    }
    defer { fixture.dispose() }
    try fixture.setCookie(name: "skyjo_account", value: "existing-account-session")

    let link = try RoomInviteLink(url: productionInviteURL)
    let redeemed = try await fixture.client.redeem(link)
    #expect(requestWasExact.get())
    #expect(redeemed.roomCode == "A1B2C")
    #expect(redeemed.expiresAt == expiresAt)
    #expect(!redeemed.isExpired(at: expiresAt - 1))
    #expect(redeemed.isExpired(at: expiresAt))
    #expect(inviteCookieValue(
      named: "skyjo_session",
      in: fixture.cookieStorage,
      for: fixture.baseURL
    ) == "outer-access-fixture")
    #expect(inviteCookieValue(
      named: "skyjo_account",
      in: fixture.cookieStorage,
      for: fixture.baseURL
    ) == "existing-account-session")
    let storedAccessCookie = try #require(
      fixture.cookieStorage.cookies(for: fixture.baseURL)?.first(where: {
        $0.name == "skyjo_session"
      })
    )
    let normalizedEndpointHost = try #require(fixture.baseURL.host?.lowercased())
    #expect(storedAccessCookie.domain.lowercased() == normalizedEndpointHost)
    #expect(!storedAccessCookie.domain.hasPrefix("."))

    let separateRequestUsedRedeemedCookie = InviteLockedValue(false)
    InviteURLProtocol.install { [expiresAt] request in
      separateRequestUsedRedeemedCookie.set(
        request.value(forHTTPHeaderField: "Cookie")?.contains(
          "skyjo_session=outer-access-fixture"
        ) == true
      )
      return try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","path":"/invite/separate_payload.separate_signature","expiresAt":\#(expiresAt)}"#,
        headers: ["Cache-Control": "private, no-store"]
      )
    }
    let separateSession = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: fixture.cookieStorage,
      protocolClasses: [InviteURLProtocol.self]
    )
    defer { separateSession.invalidateAndCancel() }
    let separateClient = RoomInviteClient(
      environment: SkyjoNetworkEnvironment(baseURL: fixture.baseURL),
      session: separateSession,
      nowMilliseconds: { inviteTestNowMilliseconds }
    )
    _ = try await separateClient.create(roomCode: "A1B2C")
    #expect(separateRequestUsedRedeemedCookie.get())
  }

  @Test("Redemption honors the configured access-cookie name and explicit HTTP policy")
  func configuredOuterAccessCookieNameAndHTTPPolicy() async throws {
    let link = try RoomInviteLink(url: productionInviteURL)

    do {
      let fixture = makeInviteFixture(outerAccessCookieName: "custom_outer_access") {
        [expiresAt] request in
        try inviteStubResponse(
          for: request,
          body: #"{"roomCode":"A1B2C","expiresAt":\#(expiresAt)}"#,
          headers: [
            "Cache-Control": "no-store",
            "Set-Cookie": "custom_outer_access=configured-value; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
          ]
        )
      }
      defer { fixture.dispose() }

      _ = try await fixture.client.redeem(link)
      #expect(inviteCookieValue(
        named: "custom_outer_access",
        in: fixture.cookieStorage,
        for: fixture.baseURL
      ) == "configured-value")
      #expect(inviteCookieValue(
        named: SkyjoNetworkEnvironment.defaultOuterAccessCookieName,
        in: fixture.cookieStorage,
        for: fixture.baseURL
      ) == nil)
    }

    do {
      let fixture = makeInviteFixture(scheme: "http") { [expiresAt] request in
        try inviteStubResponse(
          for: request,
          body: #"{"roomCode":"A1B2C","expiresAt":\#(expiresAt)}"#,
          headers: [
            "Cache-Control": "no-store",
            "Set-Cookie": "skyjo_session=http-loopback-value; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
          ]
        )
      }
      defer { fixture.dispose() }

      _ = try await fixture.client.redeem(link)
      #expect(inviteCookieValue(
        named: "skyjo_session",
        in: fixture.cookieStorage,
        for: fixture.baseURL
      ) == "http-loopback-value")
    }
  }

  @Test("Unsafe or unexpected redemption cookies never mutate authentication storage")
  func unsafeRedemptionCookiesDoNotCommit() async throws {
    let fixture = makeInviteFixture { [expiresAt] request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":\#(expiresAt)}"#,
        headers: ["Cache-Control": "no-store"]
      )
    }
    defer { fixture.dispose() }
    try fixture.setCookie(name: "skyjo_session", value: "existing-access-session")
    try fixture.setCookie(name: "skyjo_account", value: "existing-account-session")
    let link = try RoomInviteLink(url: productionInviteURL)
    let host = try #require(fixture.baseURL.host)
    let validCookie = "skyjo_session=combined-first; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure"
    let rejectedHeaders = [
      "skyjo_account=replacement-account; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
      "unexpected_cookie=unexpected; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
      "skyjo_session=wrong-path; Path=/api; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
      "skyjo_session=domain-cookie; Domain=\(host); Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
      "skyjo_session=missing-http-only; Path=/; SameSite=Lax; Max-Age=3600; Secure",
      "skyjo_session=missing-same-site; Path=/; HttpOnly; Max-Age=3600; Secure",
      "skyjo_session=strict-same-site; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure",
      "skyjo_session=session-cookie; Path=/; HttpOnly; SameSite=Lax; Secure",
      "skyjo_session=missing-secure; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
      "skyjo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "skyjo_session=deletion; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
      "\(validCookie), skyjo_account=combined-account; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
      "\(validCookie), skyjo_session=combined-second; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
      "skyjo_session=expires-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Secure",
    ]

    for header in rejectedHeaders {
      InviteURLProtocol.install { [expiresAt] request in
        try inviteStubResponse(
          for: request,
          body: #"{"roomCode":"A1B2C","expiresAt":\#(expiresAt)}"#,
          headers: [
            "Cache-Control": "no-store",
            "Set-Cookie": header,
          ]
        )
      }
      await expectInviteHTTPError(.invalidSuccessPayload) {
        _ = try await fixture.client.redeem(link)
      }
      expectInviteAuthenticationCookiesUnchanged(fixture)
    }
  }

  @Test("Expired redemption and creation DTOs fail before persistent state changes")
  func expiredInviteResponsesDoNotCommit() async throws {
    let fixture = makeInviteFixture { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800000000000}"#,
        headers: ["Cache-Control": "no-store"]
      )
    }
    defer { fixture.dispose() }
    try fixture.setCookie(name: "skyjo_session", value: "existing-access-session")
    try fixture.setCookie(name: "skyjo_account", value: "existing-account-session")
    let link = try RoomInviteLink(url: productionInviteURL)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800000000000}"#,
        headers: [
          "Cache-Control": "no-store",
          "Set-Cookie": "skyjo_session=expired-response; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
        ]
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","path":"/invite/expired.expired_signature","expiresAt":1800000000000}"#,
        headers: ["Cache-Control": "no-store"]
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.create(roomCode: "A1B2C")
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)
  }

  @Test("Rejected invite responses never mutate the shared authentication cookie jar")
  func rejectedResponsesDoNotCommitCookies() async throws {
    let fixture = makeInviteFixture { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#,
        headers: ["Cache-Control": "no-store"]
      )
    }
    defer { fixture.dispose() }
    try fixture.setCookie(name: "skyjo_session", value: "existing-access-session")
    try fixture.setCookie(name: "skyjo_account", value: "existing-account-session")
    let link = try RoomInviteLink(url: productionInviteURL)
    let poisonedCookie = "skyjo_session=unvalidated-response; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure"

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        statusCode: 302,
        body: "",
        headers: [
          "Location": "https://example.invalid/redirect",
          "Set-Cookie": poisonedCookie,
        ]
      )
    }
    await expectInviteHTTPError(.redirected) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        statusCode: 410,
        body: #"{"code":"INVITE_INVALID_OR_EXPIRED","error":"This invite is invalid or expired."}"#,
        headers: ["Set-Cookie": poisonedCookie]
      )
    }
    await expectInviteHTTPError(
      .server(
        statusCode: 410,
        code: .inviteInvalidOrExpired,
        message: "This invite is invalid or expired."
      )
    ) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#,
        contentType: "text/plain",
        headers: [
          "Cache-Control": "no-store",
          "Set-Cookie": poisonedCookie,
        ]
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#,
        headers: ["Set-Cookie": poisonedCookie]
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: "{}",
        headers: [
          "Cache-Control": "no-store",
          "Content-Length": String(RoomInviteClient.maximumResponseBytes + 1),
          "Set-Cookie": poisonedCookie,
        ]
      )
    }
    await expectInviteHTTPError(
      .responseTooLarge(limit: RoomInviteClient.maximumResponseBytes)
    ) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: "not-json",
        headers: [
          "Cache-Control": "no-store",
          "Set-Cookie": poisonedCookie,
        ]
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"abc12","expiresAt":1800003600000}"#,
        headers: [
          "Cache-Control": "no-store",
          "Set-Cookie": poisonedCookie,
        ]
      )
    }
    await expectInviteContractError(.invalidRoomCode) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#,
        headers: [
          "Cache-Control": "no-store",
          "Set-Cookie": "skyjo_session=cross-origin-response; Domain=example.invalid; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
        ]
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)

    InviteURLProtocol.installResponseThenFailure(.networkConnectionLost) { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#,
        headers: [
          "Cache-Control": "no-store",
          "Set-Cookie": poisonedCookie,
        ]
      )
    }
    await expectInviteHTTPError(.transport(.networkConnectionLost)) {
      _ = try await fixture.client.redeem(link)
    }
    expectInviteAuthenticationCookiesUnchanged(fixture)
  }

  @Test("Invite creation sends the authenticated room code and validates the returned path")
  func exactCreationRequestAndRedaction() async throws {
    let requestWasExact = InviteLockedValue(false)
    let fixture = makeInviteFixture { [expiresAt] request in
      let body = try #require(inviteRequestBody(request))
      let object = try #require(
        JSONSerialization.jsonObject(with: body) as? [String: String]
      )
      requestWasExact.set(
        request.httpMethod == "POST"
          && request.url?.path == "/api/rooms/invite"
          && request.value(forHTTPHeaderField: "Cookie")?.contains(
            "skyjo_session=existing-access-session"
          ) == true
          && request.value(forHTTPHeaderField: "Cookie")?.contains(
            "skyjo_account=existing-account-session"
          ) == true
          && Set(object.keys) == ["roomCode"]
          && object["roomCode"] == "A1B2C"
      )
      return try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","path":"/invite/created_payload.created_signature","expiresAt":\#(expiresAt)}"#,
        headers: [
          "Cache-Control": "no-store",
          "Set-Cookie": "skyjo_session=unexpected-creation-cookie; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
        ]
      )
    }
    defer { fixture.dispose() }
    try fixture.setCookie(name: "skyjo_session", value: "existing-access-session")
    try fixture.setCookie(name: "skyjo_account", value: "existing-account-session")

    let invite = try await fixture.client.create(roomCode: "A1B2C")
    #expect(requestWasExact.get())
    #expect(invite.roomCode == "A1B2C")
    #expect(invite.expiresAt == expiresAt)
    #expect(invite.url == fixture.baseURL.appending(path: "invite/created_payload.created_signature"))
    #expect(inviteCookieValue(
      named: "skyjo_session",
      in: fixture.cookieStorage,
      for: fixture.baseURL
    ) == "existing-access-session")
    #expect(inviteCookieValue(
      named: "skyjo_account",
      in: fixture.cookieStorage,
      for: fixture.baseURL
    ) == "existing-account-session")

    for rendered in [String(describing: invite), String(reflecting: invite)] {
      #expect(!rendered.contains("A1B2C"))
      #expect(!rendered.contains("created_payload"))
      #expect(!rendered.contains(String(expiresAt)))
      #expect(!rendered.contains(fixture.baseURL.host ?? "invite-host"))
    }
  }

  @Test("Success responses require direct JSON no-store replies and bounded values")
  func successResponseBoundaries() async throws {
    let fixture = makeInviteFixture { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#,
        headers: ["Cache-Control": "no-store"]
      )
    }
    defer { fixture.dispose() }
    let link = try RoomInviteLink(url: productionInviteURL)

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.redeem(link)
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#,
        contentType: "text/plain",
        headers: ["Cache-Control": "no-store"]
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.redeem(link)
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        statusCode: 302,
        body: "",
        headers: ["Location": "https://example.invalid/redirect"]
      )
    }
    await expectInviteHTTPError(.redirected) {
      _ = try await fixture.client.redeem(link)
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":1800003600000}"#,
        headers: ["Cache-Control": "no-store"],
        responseURL: URL(string: "https://different-origin.invalid/api/rooms/invite/redeem")!
      )
    }
    await expectInviteHTTPError(.redirected) {
      _ = try await fixture.client.redeem(link)
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"abc12","expiresAt":1800003600000}"#,
        headers: ["Cache-Control": "no-store"]
      )
    }
    await expectInviteContractError(.invalidRoomCode) {
      _ = try await fixture.client.redeem(link)
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: #"{"roomCode":"A1B2C","expiresAt":-1}"#,
        headers: ["Cache-Control": "no-store"]
      )
    }
    await expectInviteContractError(.invalidExpiry) {
      _ = try await fixture.client.redeem(link)
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: "{}",
        headers: [
          "Cache-Control": "no-store",
          "Content-Length": String(RoomInviteClient.maximumResponseBytes + 1),
        ]
      )
    }
    await expectInviteHTTPError(
      .responseTooLarge(limit: RoomInviteClient.maximumResponseBytes)
    ) {
      _ = try await fixture.client.redeem(link)
    }

    let validCreationBody = #"{"roomCode":"A1B2C","path":"/invite/created.created_signature","expiresAt":1800003600000}"#
    InviteURLProtocol.install { request in
      try inviteStubResponse(for: request, body: validCreationBody)
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.create(roomCode: "A1B2C")
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        body: validCreationBody,
        headers: ["Cache-Control": "private, no-store-ish"]
      )
    }
    await expectInviteHTTPError(.invalidSuccessPayload) {
      _ = try await fixture.client.create(roomCode: "A1B2C")
    }

    await #expect(throws: RoomInviteContractError.invalidRoomCode) {
      _ = try await fixture.client.create(roomCode: "abc12")
    }
    #expect(throws: RoomInviteContractError.invalidExpiry) {
      _ = try RedeemedRoomInvite(
        roomCode: "A1B2C",
        expiresAt: 9_007_199_254_740_992
      )
    }
  }

  @Test("Unknown-length invite responses cancel immediately at the streaming cap")
  func streamingResponseBoundary() async throws {
    let prefix = Data(#"{"roomCode":"A1B2C","expiresAt":1800003600000}"#.utf8)
    let generation = InviteStreamingURLProtocol.reset(
      totalBytes: RoomInviteClient.maximumResponseBytes + 1,
      prefix: prefix
    )
    let baseURL = URL(string: "https://invite-stream-\(UUID().uuidString.lowercased()).test")!
    let cookieStorage = HTTPCookieStorage.shared
    clearInviteCookies(cookieStorage, for: baseURL)
    let host = try #require(baseURL.host)
    for (name, value) in [
      ("skyjo_session", "existing-access-session"),
      ("skyjo_account", "existing-account-session"),
    ] {
      let cookie = try #require(HTTPCookie(properties: [
        .domain: host,
        .name: name,
        .path: "/",
        .value: value,
        .secure: "TRUE",
      ]))
      cookieStorage.setCookie(cookie)
    }
    let session = SkyjoURLSessionFactory.makeDedicated(
      cookieStorage: cookieStorage,
      protocolClasses: [InviteStreamingURLProtocol.self]
    )
    let client = RoomInviteClient(
      environment: SkyjoNetworkEnvironment(baseURL: baseURL),
      session: session,
      nowMilliseconds: { inviteTestNowMilliseconds }
    )
    defer {
      session.invalidateAndCancel()
      clearInviteCookies(cookieStorage, for: baseURL)
    }

    let link = try RoomInviteLink(url: productionInviteURL)
    await expectInviteHTTPError(
      .responseTooLarge(limit: RoomInviteClient.maximumResponseBytes)
    ) {
      _ = try await client.redeem(link)
    }
    for _ in 0..<100 where !InviteStreamingURLProtocol.wasStopped(generation) {
      try? await Task<Never, Never>.sleep(for: .milliseconds(10))
    }
    #expect(InviteStreamingURLProtocol.wasStopped(generation))
    #expect(InviteStreamingURLProtocol.deliveredBytes(generation) <= RoomInviteClient.maximumResponseBytes + 1)
    #expect(inviteCookieValue(
      named: "skyjo_session",
      in: cookieStorage,
      for: baseURL
    ) == "existing-access-session")
    #expect(inviteCookieValue(
      named: "skyjo_account",
      in: cookieStorage,
      for: baseURL
    ) == "existing-account-session")
  }

  @Test("Known invite errors are typed while unknown or malformed detail is hidden")
  func stableAndSafeErrorMapping() async throws {
    let fixture = makeInviteFixture { request in
      try inviteStubResponse(
        for: request,
        statusCode: 410,
        body: #"{"code":"INVITE_INVALID_OR_EXPIRED","error":"This invite is invalid or expired."}"#
      )
    }
    defer { fixture.dispose() }
    let link = try RoomInviteLink(url: productionInviteURL)

    let knownErrors: [(Int, String, String, SkyjoAPIErrorCode)] = [
      (410, "INVITE_INVALID_OR_EXPIRED", "This invite is invalid or expired.", .inviteInvalidOrExpired),
      (410, "INVITE_ROOM_UNAVAILABLE", "This room is no longer available.", .inviteRoomUnavailable),
      (429, "INVITE_RATE_LIMITED", "Try again later.", .inviteRateLimited),
    ]
    for (status, code, message, expectedCode) in knownErrors {
      InviteURLProtocol.install { request in
        try inviteStubResponse(
          for: request,
          statusCode: status,
          body: #"{"code":"\#(code)","error":"\#(message)"}"#,
          headers: status == 429 ? ["Retry-After": "60"] : [:]
        )
      }
      await expectInviteHTTPError(
        .server(statusCode: status, code: expectedCode, message: message)
      ) {
        _ = try await fixture.client.redeem(link)
      }
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        statusCode: 500,
        body: #"{"code":"FUTURE_PRIVATE_CODE","error":"Never display this private detail."}"#
      )
    }
    await expectInviteHTTPError(
      .server(
        statusCode: 500,
        code: SkyjoAPIErrorCode(rawValue: "FUTURE_PRIVATE_CODE"),
        message: SkyjoHTTPClientError.safeFallbackMessage
      )
    ) {
      _ = try await fixture.client.redeem(link)
    }

    InviteURLProtocol.install { request in
      try inviteStubResponse(
        for: request,
        statusCode: 500,
        body: #"{"code":"INVITE_INVALID_OR_EXPIRED","error":"\#(String(repeating: "x", count: 513))"}"#
      )
    }
    await expectInviteHTTPError(
      .server(
        statusCode: 500,
        code: nil,
        message: SkyjoHTTPClientError.safeFallbackMessage
      )
    ) {
      _ = try await fixture.client.redeem(link)
    }

    InviteURLProtocol.install { _ in throw URLError(.notConnectedToInternet) }
    await expectInviteHTTPError(.transport(.notConnectedToInternet)) {
      _ = try await fixture.client.redeem(link)
    }
  }

  @Test("Seat recovery records validate routing fields and partition volatile state by account")
  func volatileSeatRecoveryValidationAndPartition() async throws {
    let accountA = try #require(UUID(uuidString: "30000000-0000-4000-8000-000000000003"))
    let accountB = try #require(UUID(uuidString: "30000000-0000-4000-8000-000000000004"))
    let record = try RoomSeatRecoveryRecord(
      accountID: accountA,
      roomCode: "A1B2C",
      playerID: "seat-a"
    )

    #expect(throws: RoomConnectionContractError.invalidAdmission) {
      _ = try RoomSeatRecoveryRecord(
        accountID: UUID(uuidString: "00000000-0000-0000-0000-000000000000")!,
        roomCode: "A1B2C",
        playerID: "seat-a"
      )
    }
    #expect(throws: RoomConnectionContractError.invalidAdmission) {
      _ = try RoomSeatRecoveryRecord(
        accountID: accountA,
        roomCode: "abc12",
        playerID: "seat-a"
      )
    }
    #expect(throws: RoomConnectionContractError.invalidAdmission) {
      _ = try RoomSeatRecoveryRecord(
        accountID: accountA,
        roomCode: "A1B2C",
        playerID: ""
      )
    }
    #expect(throws: RoomConnectionContractError.invalidAdmission) {
      _ = try RoomSeatRecoveryRecord(
        accountID: accountA,
        roomCode: "A1B2C",
        playerID: String(repeating: "p", count: 129)
      )
    }
    #expect(throws: (any Error).self) {
      _ = try JSONDecoder().decode(
        RoomSeatRecoveryRecord.self,
        from: Data(
          #"{"accountID":"30000000-0000-4000-8000-000000000003","roomCode":"abc12","playerID":"seat-a"}"#.utf8
        )
      )
    }

    let store = VolatileRoomSeatRecoveryStore(record: record)
    #expect(await store.load(accountID: accountA) == record)
    #expect(await store.load(accountID: accountB) == nil)
    await store.clear(accountID: accountB)
    #expect(await store.load(accountID: accountA) == record)
    await store.clear(accountID: accountA)
    #expect(await store.load(accountID: accountA) == nil)
    await store.clear(accountID: accountA)
  }

  @Test("File seat recovery is exact, account-fenced, corruption-safe, and idempotently cleared")
  func fileSeatRecoveryValidationPartitionCorruptionAndClear() async throws {
    let accountA = try #require(UUID(uuidString: "30000000-0000-4000-8000-000000000003"))
    let accountB = try #require(UUID(uuidString: "30000000-0000-4000-8000-000000000004"))
    let root = FileManager.default.temporaryDirectory
      .appending(path: "skyjo-room-seat-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    let fileURL = root.appending(path: "seat.json", directoryHint: .notDirectory)
    let store = FileRoomSeatRecoveryStore(fileURL: fileURL)
    defer { try? FileManager.default.removeItem(at: root) }

    #expect(try await store.load(accountID: accountA) == nil)
    let record = try RoomSeatRecoveryRecord(
      accountID: accountA,
      roomCode: "A1B2C",
      playerID: "private-seat-a"
    )
    try await store.save(record)
    #expect(try await store.load(accountID: accountA) == record)
    #expect(try await store.load(accountID: accountB) == nil)

    let storedData = try Data(contentsOf: fileURL)
    let storedObject = try #require(
      JSONSerialization.jsonObject(with: storedData) as? [String: Any]
    )
    #expect(Set(storedObject.keys) == ["accountID", "roomCode", "playerID"])
    #expect(storedData.count <= FileRoomSeatRecoveryStore.maximumRecordBytes)
    #expect(!String(decoding: storedData, as: UTF8.self).contains("invite"))

    try await store.clear(accountID: accountB)
    #expect(try await store.load(accountID: accountA) == record)
    try await store.clear(accountID: accountA)
    #expect(try await store.load(accountID: accountA) == nil)
    try await store.clear(accountID: accountA)

    try FileManager.default.createDirectory(
      at: root,
      withIntermediateDirectories: true
    )
    for corrupted in [
      Data("not-json".utf8),
      Data(
        #"{"accountID":"30000000-0000-4000-8000-000000000003","roomCode":"A1B2C","playerID":"seat-a","extra":"forbidden"}"#.utf8
      ),
      Data(
        #"{"accountID":"30000000-0000-4000-8000-000000000003","roomCode":"abc12","playerID":"seat-a"}"#.utf8
      ),
      Data(repeating: 0x20, count: FileRoomSeatRecoveryStore.maximumRecordBytes + 1),
    ] {
      try corrupted.write(to: fileURL, options: [.atomic])
      await expectSeatLoadFailure(store, accountID: accountA)
      try await store.clear(accountID: accountA)
      #expect(try await store.load(accountID: accountA) == nil)
    }

    let remoteStore = FileRoomSeatRecoveryStore(
      fileURL: URL(string: "https://example.invalid/seat.json")!
    )
    await expectSeatLoadFailure(remoteStore, accountID: accountA)
  }
}

private struct InviteClientFixture {
  let client: RoomInviteClient
  let session: URLSession
  let cookieStorage: HTTPCookieStorage
  let baseURL: URL

  func setCookie(name: String, value: String) throws {
    let host = try #require(baseURL.host)
    let cookie = try #require(HTTPCookie(properties: [
      .domain: host,
      .name: name,
      .path: "/",
      .value: value,
      .secure: "TRUE",
    ]))
    cookieStorage.setCookie(cookie)
  }

  func dispose() {
    session.invalidateAndCancel()
    clearInviteCookies(cookieStorage, for: baseURL)
    InviteURLProtocol.removeHandler()
  }
}

private func makeInviteFixture(
  scheme: String = "https",
  outerAccessCookieName: String = SkyjoNetworkEnvironment.defaultOuterAccessCookieName,
  nowMilliseconds: Int64 = inviteTestNowMilliseconds,
  handler: @escaping InviteURLProtocol.Handler
) -> InviteClientFixture {
  InviteURLProtocol.install(handler)
  let baseURL = URL(string: "\(scheme)://invite-\(UUID().uuidString.lowercased()).test")!
  let cookieStorage = HTTPCookieStorage.shared
  clearInviteCookies(cookieStorage, for: baseURL)
  let session = SkyjoURLSessionFactory.makeDedicated(
    cookieStorage: cookieStorage,
    protocolClasses: [InviteURLProtocol.self]
  )
  return InviteClientFixture(
    client: RoomInviteClient(
      environment: SkyjoNetworkEnvironment(
        baseURL: baseURL,
        outerAccessCookieName: outerAccessCookieName
      ),
      session: session,
      nowMilliseconds: { nowMilliseconds }
    ),
    session: session,
    cookieStorage: cookieStorage,
    baseURL: baseURL
  )
}

private final class InviteURLProtocol: URLProtocol, @unchecked Sendable {
  typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data)

  private static let handler = InviteLockedValue<Handler?>(nil)
  private static let failureAfterResponse = InviteLockedValue<URLError.Code?>(nil)

  static func install(_ handler: @escaping Handler) {
    self.handler.set(handler)
    failureAfterResponse.set(nil)
  }

  static func installResponseThenFailure(
    _ code: URLError.Code,
    handler: @escaping Handler
  ) {
    self.handler.set(handler)
    failureAfterResponse.set(code)
  }

  static func removeHandler() {
    handler.set(nil)
    failureAfterResponse.set(nil)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let handler = Self.handler.get() else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    do {
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      if let code = Self.failureAfterResponse.get() {
        client?.urlProtocol(self, didFailWithError: URLError(code))
        return
      }
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

private final class InviteStreamingURLProtocol: URLProtocol, @unchecked Sendable {
  private struct Configuration: Sendable {
    let generation: Int
    let totalBytes: Int
    let prefix: Data
  }

  private struct Delivery: Sendable {
    let generation: Int
    let byteCount: Int
  }

  private static let configuration = InviteLockedValue(
    Configuration(generation: 0, totalBytes: 0, prefix: Data())
  )
  private static let delivery = InviteLockedValue(Delivery(generation: 0, byteCount: 0))
  private static let stoppedGeneration = InviteLockedValue<Int?>(nil)

  private let deliveryQueue = DispatchQueue(label: "com.groundworkrevops.skyjo.tests.invite-stream")
  private var generation = 0
  private var totalBytes = 0
  private var prefix = Data()

  static func reset(totalBytes: Int, prefix: Data) -> Int {
    let generation = configuration.get().generation + 1
    configuration.set(Configuration(
      generation: generation,
      totalBytes: totalBytes,
      prefix: prefix
    ))
    delivery.set(Delivery(generation: generation, byteCount: 0))
    stoppedGeneration.set(nil)
    return generation
  }

  static func wasStopped(_ generation: Int) -> Bool {
    stoppedGeneration.get() == generation
  }

  static func deliveredBytes(_ generation: Int) -> Int {
    let current = delivery.get()
    return current.generation == generation ? current.byteCount : 0
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let configuration = Self.configuration.get()
    generation = configuration.generation
    totalBytes = configuration.totalBytes
    prefix = configuration.prefix
    guard let url = request.url,
          let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "Set-Cookie": "skyjo_session=unvalidated-response; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure",
            ]
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
    let work = DispatchWorkItem { [weak self] in
      guard let self,
            Self.configuration.get().generation == self.generation,
            !Self.wasStopped(self.generation)
      else { return }
      let delivered = Self.deliveredBytes(self.generation)
      guard delivered < self.totalBytes else {
        self.client?.urlProtocolDidFinishLoading(self)
        return
      }

      let chunkSize = min(4_096, self.totalBytes - delivered)
      var chunk = Data(repeating: 0x20, count: chunkSize)
      if delivered < self.prefix.count {
        let end = min(self.prefix.count, delivered + chunkSize)
        chunk.replaceSubrange(0..<(end - delivered), with: self.prefix[delivered..<end])
      }
      Self.delivery.set(Delivery(
        generation: self.generation,
        byteCount: delivered + chunkSize
      ))
      self.client?.urlProtocol(self, didLoad: chunk)
      self.scheduleNextChunk()
    }
    deliveryQueue.asyncAfter(deadline: .now() + .milliseconds(2), execute: work)
  }
}

private final class InviteLockedValue<Value: Sendable>: @unchecked Sendable {
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

private func inviteRequestBody(_ request: URLRequest) -> Data? {
  if let body = request.httpBody { return body }
  guard let stream = request.httpBodyStream else { return nil }
  stream.open()
  defer { stream.close() }
  var body = Data()
  var buffer = [UInt8](repeating: 0, count: 4_096)
  while true {
    let count = stream.read(&buffer, maxLength: buffer.count)
    guard count >= 0 else { return nil }
    if count == 0 { return body }
    body.append(contentsOf: buffer.prefix(count))
  }
}

private func inviteStubResponse(
  for request: URLRequest,
  statusCode: Int = 200,
  body: String,
  contentType: String = "application/json; charset=utf-8",
  headers: [String: String] = [:],
  responseURL: URL? = nil
) throws -> (HTTPURLResponse, Data) {
  var allHeaders = headers
  allHeaders["Content-Type"] = contentType
  let url = try #require(responseURL ?? request.url)
  let response = try #require(HTTPURLResponse(
    url: url,
    statusCode: statusCode,
    httpVersion: "HTTP/1.1",
    headerFields: allHeaders
  ))
  return (response, Data(body.utf8))
}

private func expectInviteHTTPError(
  _ expected: SkyjoHTTPClientError,
  operation: () async throws -> Void
) async {
  do {
    try await operation()
    Issue.record("Expected the invite request to fail.")
  } catch let error as SkyjoHTTPClientError {
    #expect(error == expected)
  } catch {
    Issue.record("Invite request failed with an unexpected error type: \(type(of: error)).")
  }
}

private func expectInviteContractError(
  _ expected: RoomInviteContractError,
  operation: () async throws -> Void
) async {
  do {
    try await operation()
    Issue.record("Expected invite contract validation to fail.")
  } catch let error as RoomInviteContractError {
    #expect(error == expected)
  } catch {
    Issue.record("Invite validation failed with an unexpected error type: \(type(of: error)).")
  }
}

private func expectSeatLoadFailure(
  _ store: FileRoomSeatRecoveryStore,
  accountID: UUID
) async {
  do {
    _ = try await store.load(accountID: accountID)
    Issue.record("Corrupt seat recovery data was accepted.")
  } catch {
    // Expected: corrupt or non-file recovery inputs fail closed.
  }
}

private func inviteCookieValue(
  named name: String,
  in storage: HTTPCookieStorage,
  for url: URL
) -> String? {
  storage.cookies(for: url)?.first(where: { $0.name == name })?.value
}

private func expectInviteAuthenticationCookiesUnchanged(_ fixture: InviteClientFixture) {
  let cookies = fixture.cookieStorage.cookies(for: fixture.baseURL) ?? []
  #expect(cookies.count == 2)
  #expect(Set(cookies.map(\.name)) == ["skyjo_session", "skyjo_account"])
  #expect(inviteCookieValue(
    named: "skyjo_session",
    in: fixture.cookieStorage,
    for: fixture.baseURL
  ) == "existing-access-session")
  #expect(inviteCookieValue(
    named: "skyjo_account",
    in: fixture.cookieStorage,
    for: fixture.baseURL
  ) == "existing-account-session")
}

private func clearInviteCookies(_ storage: HTTPCookieStorage, for url: URL) {
  for cookie in storage.cookies(for: url) ?? [] {
    storage.deleteCookie(cookie)
  }
}

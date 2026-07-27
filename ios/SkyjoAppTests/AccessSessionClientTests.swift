import Foundation
import SkyjoNetworking
import Testing

@Suite("Access session HTTP client", .serialized)
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
    StreamingURLProtocol.reset()
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

    for _ in 0..<100 where !StreamingURLProtocol.wasStopped.get() {
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(StreamingURLProtocol.wasStopped.get())
    #expect(StreamingURLProtocol.deliveredBytes.get() < StreamingURLProtocol.totalBytes)
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
  static let totalBytes = AccessSessionClient.maximumResponseBytes * 8
  static let deliveredBytes = LockedValue(0)
  static let wasStopped = LockedValue(false)

  private let deliveryQueue = DispatchQueue(label: "com.groundworkrevops.skyjo.tests.stream")

  static func reset() {
    deliveredBytes.set(0)
    wasStopped.set(false)
  }

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
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
    Self.wasStopped.set(true)
  }

  private func scheduleNextChunk() {
    let workItem = DispatchWorkItem { [weak self] in
      guard let self, !Self.wasStopped.get() else { return }
      let delivered = Self.deliveredBytes.get()
      guard delivered < Self.totalBytes else {
        self.client?.urlProtocolDidFinishLoading(self)
        return
      }

      let chunkSize = min(4_096, Self.totalBytes - delivered)
      Self.deliveredBytes.set(delivered + chunkSize)
      self.client?.urlProtocol(self, didLoad: Data(repeating: 0x20, count: chunkSize))
      self.scheduleNextChunk()
    }
    deliveryQueue.asyncAfter(deadline: .now() + .milliseconds(2), execute: workItem)
  }
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

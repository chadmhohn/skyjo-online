import CoreFoundation
import Foundation
import SkyjoNetworking

enum MixedPWAControlError: Error, Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  case unavailable
  case invalidConfiguration
  case invalidRequest
  case invalidResponse
  case redirected
  case responseTooLarge
  case rejected(operation: String, code: String)
  case transport

  var description: String { debugDescription }
  var debugDescription: String {
    switch self {
    case .unavailable: "MixedPWAControlError.unavailable"
    case .invalidConfiguration: "MixedPWAControlError.invalidConfiguration"
    case .invalidRequest: "MixedPWAControlError.invalidRequest"
    case .invalidResponse: "MixedPWAControlError.invalidResponse"
    case .redirected: "MixedPWAControlError.redirected"
    case .responseTooLarge: "MixedPWAControlError.responseTooLarge"
    case .rejected(let operation, let code):
      "MixedPWAControlError.rejected(operation: \(operation), code: \(code))"
    case .transport: "MixedPWAControlError.transport"
    }
  }
}

enum MixedPWAChatCase: String, Sendable {
  case duplicate
  case fresh
  case stale
  case advance
  case heartbeat
  case maximumAstral = "maximum-astral"
}

actor MixedPWAControlClient {
  static let maximumRequestBytes = 16_384
  static let maximumResponseBytes = 8_192
  static let networkingTestMode = "networking-contracts"

  private static let allowedErrorCodes = Set([
    "forbidden",
    "invalid-arguments",
    "invalid-request",
    "invalid-state",
    "not-found",
    "operation-failed",
    "request-too-large",
  ])

  private let commandURL: URL
  private let healthURL: URL
  private let session: URLSession

  static var networkingTestsEnabled: Bool {
    ProcessInfo.processInfo.environment["SKYJO_IOS_TEST_MODE"] == networkingTestMode
  }

  static func requiredFromEnvironment() throws -> MixedPWAControlClient {
    guard networkingTestsEnabled else { throw MixedPWAControlError.unavailable }
    guard let rawOrigin = ProcessInfo.processInfo.environment["SKYJO_IOS_PWA_CONTROL_URL"] else {
      throw MixedPWAControlError.unavailable
    }
    return try MixedPWAControlClient(controlOrigin: rawOrigin)
  }

  init(controlOrigin rawOrigin: String) throws {
    guard let origin = URL(string: rawOrigin),
          let components = URLComponents(url: origin, resolvingAgainstBaseURL: false),
          components.scheme == "http",
          components.host == "127.0.0.1",
          let port = components.port,
          (1...65_535).contains(port),
          components.user == nil,
          components.password == nil,
          components.path.isEmpty,
          components.query == nil,
          components.fragment == nil,
          origin.absoluteString == "http://127.0.0.1:\(port)"
    else { throw MixedPWAControlError.invalidConfiguration }

    commandURL = origin.appending(path: "v1/command")
    healthURL = origin.appending(path: "v1/health")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 20
    session = URLSession(
      configuration: configuration,
      delegate: MixedPWARedirectRejectingDelegate(),
      delegateQueue: nil
    )
  }

  func dispose() {
    session.invalidateAndCancel()
  }

  func hasCredentiallessSessionConfiguration() -> Bool {
    let configuration = session.configuration
    return configuration.httpCookieStorage == nil
      && configuration.httpShouldSetCookies == false
      && configuration.urlCredentialStorage == nil
      && configuration.urlCache == nil
  }

  func health() async throws {
    var request = URLRequest(url: healthURL)
    request.httpMethod = "GET"
    setControlHeaders(on: &request)
    let (data, response) = try await transport(request)
    guard response.statusCode == 200,
          isJSON(response),
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(value.keys) == ["version", "ready"],
          exactInteger(value["version"]) == 1,
          exactBoolean(value["ready"]) == true
    else { throw MixedPWAControlError.invalidResponse }
  }

  func reset() async throws {
    _ = try await perform("reset", arguments: [:], resultKeys: ["state"])
  }

  func provision(displayName: String) async throws {
    _ = try await perform(
      "provision",
      arguments: ["displayName": displayName],
      resultKeys: ["state"]
    )
  }

  func createRoom() async throws -> String {
    let result = try await perform("create-room", arguments: [:], resultKeys: ["roomCode"])
    guard let roomCode = result["roomCode"] as? String,
          roomCode.range(of: #"^[A-Z0-9]{5}$"#, options: .regularExpression) != nil
    else { throw MixedPWAControlError.invalidResponse }
    return roomCode
  }

  func joinRoom(_ roomCode: String) async throws {
    let result = try await perform(
      "join-room",
      arguments: ["roomCode": roomCode],
      resultKeys: ["joined"]
    )
    try requireTrue(result, key: "joined")
  }

  func waitPlayer(
    displayName: String,
    connected: Bool? = nil,
    controller: RoomPlayerController? = nil,
    host: Bool? = nil
  ) async throws {
    let result = try await perform(
      "wait-player",
      arguments: [
        "displayName": displayName,
        "connected": connected.map(String.init) ?? "",
        "controller": controller?.rawValue ?? "",
        "host": host.map(String.init) ?? "",
      ],
      resultKeys: ["matched"]
    )
    try requireTrue(result, key: "matched")
  }

  func waitConnection(_ state: RoomConnectionPhase) async throws {
    let result = try await perform(
      "wait-connection",
      arguments: ["state": state.rawValue],
      resultKeys: ["matched"]
    )
    try requireTrue(result, key: "matched")
  }

  func sendChat(_ chatCase: MixedPWAChatCase, duplicate: Bool = false) async throws {
    let result = try await perform(
      "send-chat",
      arguments: [
        "case": chatCase.rawValue,
        "delivery": duplicate ? "duplicate" : "normal",
      ],
      resultKeys: ["sent"]
    )
    try requireTrue(result, key: "sent")
  }

  func holdChat(_ chatCase: MixedPWAChatCase) async throws {
    let result = try await perform(
      "hold-chat",
      arguments: ["case": chatCase.rawValue],
      resultKeys: ["held"]
    )
    try requireTrue(result, key: "held")
  }

  func releaseHeldCommand() async throws {
    let result = try await perform(
      "release-held-command",
      arguments: [:],
      resultKeys: ["resynchronized"]
    )
    try requireTrue(result, key: "resynchronized")
  }

  func waitChat(_ chatCase: MixedPWAChatCase) async throws {
    let result = try await perform(
      "wait-chat",
      arguments: ["case": chatCase.rawValue],
      resultKeys: ["matched"]
    )
    try requireTrue(result, key: "matched")
  }

  func setVisible(_ visible: Bool) async throws -> Bool {
    let result = try await perform(
      "set-visible",
      arguments: ["visible": String(visible)],
      resultKeys: ["sameSocket"]
    )
    return try requiredBool(result, key: "sameSocket")
  }

  func setOffline(_ offline: Bool) async throws -> Bool {
    let result = try await perform(
      "set-offline",
      arguments: ["offline": String(offline)],
      resultKeys: ["sameSeat"]
    )
    return try requiredBool(result, key: "sameSeat")
  }

  func closePage() async throws {
    let result = try await perform("close-page", arguments: [:], resultKeys: ["closed"])
    try requireTrue(result, key: "closed")
  }

  func reopenPage() async throws -> Bool {
    let result = try await perform("reopen-page", arguments: [:], resultKeys: ["sameSeat"])
    return try requiredBool(result, key: "sameSeat")
  }

  func startGame() async throws {
    let result = try await perform("start-game", arguments: [:], resultKeys: ["started"])
    try requireTrue(result, key: "started")
  }

  func revealOpening(count: Int) async throws {
    let result = try await perform(
      "reveal-opening",
      arguments: ["count": String(count)],
      resultKeys: ["revealed"]
    )
    try requireTrue(result, key: "revealed")
  }

  private func perform(
    _ operation: String,
    arguments: [String: String],
    resultKeys: Set<String>
  ) async throws -> [String: Any] {
    let requestID = UUID().uuidString.lowercased()
    let object: [String: Any] = [
      "version": 1,
      "id": requestID,
      "operation": operation,
      "arguments": arguments,
    ]
    guard JSONSerialization.isValidJSONObject(object) else {
      throw MixedPWAControlError.invalidRequest
    }
    let body = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    guard body.count <= Self.maximumRequestBytes else {
      throw MixedPWAControlError.invalidRequest
    }
    var request = URLRequest(url: commandURL)
    request.httpMethod = "POST"
    request.httpBody = body
    setControlHeaders(on: &request)

    let (data, response) = try await transport(request)
    guard isJSON(response),
          let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          exactInteger(value["version"]) == 1,
          value["id"] as? String == requestID,
          let ok = exactBoolean(value["ok"])
    else { throw MixedPWAControlError.invalidResponse }

    if ok {
      guard response.statusCode == 200,
            Set(value.keys) == ["version", "id", "ok", "result"],
            let result = value["result"] as? [String: Any],
            Set(result.keys) == resultKeys,
            result.values.allSatisfy({ $0 is String || exactBoolean($0) != nil })
      else { throw MixedPWAControlError.invalidResponse }
      return result
    }

    guard (400...499).contains(response.statusCode),
          Set(value.keys) == ["version", "id", "ok", "error"],
          let error = value["error"] as? [String: Any],
          Set(error.keys) == ["code"],
          let code = error["code"] as? String,
          Self.allowedErrorCodes.contains(code)
    else { throw MixedPWAControlError.invalidResponse }
    throw MixedPWAControlError.rejected(operation: operation, code: code)
  }

  private func transport(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    do {
      let (bytes, rawResponse) = try await session.bytes(for: request)
      guard let response = rawResponse as? HTTPURLResponse,
            response.url == request.url
      else { throw MixedPWAControlError.invalidResponse }
      guard !(300...399).contains(response.statusCode) else {
        throw MixedPWAControlError.redirected
      }
      guard response.expectedContentLength <= Int64(Self.maximumResponseBytes) else {
        throw MixedPWAControlError.responseTooLarge
      }
      var data = Data()
      data.reserveCapacity(
        response.expectedContentLength > 0
          ? min(Int(response.expectedContentLength), Self.maximumResponseBytes)
          : 0
      )
      for try await byte in bytes {
        guard data.count < Self.maximumResponseBytes else {
          throw MixedPWAControlError.responseTooLarge
        }
        data.append(byte)
      }
      return (data, response)
    } catch let error as MixedPWAControlError {
      throw error
    } catch {
      throw MixedPWAControlError.transport
    }
  }

  private func setControlHeaders(on request: inout URLRequest) {
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("1", forHTTPHeaderField: "X-Skyjo-IOS-Mixed-Control")
    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
  }

  private func isJSON(_ response: HTTPURLResponse) -> Bool {
    response.value(forHTTPHeaderField: "Content-Type")?
      .split(separator: ";", maxSplits: 1).first?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() == "application/json"
  }

  private func requiredBool(_ result: [String: Any], key: String) throws -> Bool {
    guard let value = exactBoolean(result[key]) else { throw MixedPWAControlError.invalidResponse }
    return value
  }

  private func requireTrue(_ result: [String: Any], key: String) throws {
    guard try requiredBool(result, key: key) else { throw MixedPWAControlError.invalidResponse }
  }
}

private func exactInteger(_ value: Any?) -> Int? {
  guard let number = value as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID()
  else { return nil }
  let integer = number.intValue
  guard number == NSNumber(value: integer) else { return nil }
  return integer
}

private func exactBoolean(_ value: Any?) -> Bool? {
  guard let number = value as? NSNumber,
        CFGetTypeID(number) == CFBooleanGetTypeID()
  else { return nil }
  return number.boolValue
}

private final class MixedPWARedirectRejectingDelegate: NSObject, URLSessionTaskDelegate,
  @unchecked Sendable {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

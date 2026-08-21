import Foundation

public struct AccessSessionStatus: Decodable, Equatable, Sendable {
  public let authenticated: Bool

  public init(authenticated: Bool) {
    self.authenticated = authenticated
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    authenticated = try container.decode(Bool.self, forKey: .authenticated)
  }

  private enum CodingKeys: String, CodingKey {
    case authenticated
  }
}

public struct SkyjoAPIErrorCode: RawRepresentable, Equatable, Hashable, Sendable {
  public static let accessRequired = Self(rawValue: "ACCESS_REQUIRED")
  public static let accessAuthenticationFailed = Self(rawValue: "ACCESS_AUTHENTICATION_FAILED")
  public static let accountAuthenticationFailed = Self(rawValue: "ACCOUNT_AUTHENTICATION_FAILED")
  public static let accountAuthenticationRequired = Self(rawValue: "ACCOUNT_AUTHENTICATION_REQUIRED")
  public static let accountRateLimited = Self(rawValue: "ACCOUNT_RATE_LIMITED")
  public static let accountExists = Self(rawValue: "ACCOUNT_EXISTS")
  public static let accountNotFound = Self(rawValue: "ACCOUNT_NOT_FOUND")
  public static let accountSessionChanged = Self(rawValue: "ACCOUNT_SESSION_CHANGED")
  public static let apnsDeviceLimit = Self(rawValue: "APNS_DEVICE_LIMIT")
  public static let apnsNotConfigured = Self(rawValue: "APNS_NOT_CONFIGURED")
  public static let apnsRegistrationRateLimited = Self(rawValue: "APNS_REGISTRATION_RATE_LIMITED")
  public static let adminRequired = Self(rawValue: "ADMIN_REQUIRED")
  public static let adminSelfRevokeForbidden = Self(rawValue: "ADMIN_SELF_REVOKE_FORBIDDEN")
  public static let apiRouteNotFound = Self(rawValue: "API_ROUTE_NOT_FOUND")
  public static let codeAllocationFailed = Self(rawValue: "CODE_ALLOCATION_FAILED")
  public static let currentPasswordMismatch = Self(rawValue: "CURRENT_PASSWORD_MISMATCH")
  public static let expectedJSONObject = Self(rawValue: "EXPECTED_JSON_OBJECT")
  public static let gameNotFound = Self(rawValue: "GAME_NOT_FOUND")
  public static let incompleteGame = Self(rawValue: "INCOMPLETE_GAME")
  public static let invalidCompletedAt = Self(rawValue: "INVALID_COMPLETED_AT")
  public static let invalidEmail = Self(rawValue: "INVALID_EMAIL")
  public static let invalidJSON = Self(rawValue: "INVALID_JSON")
  public static let invalidPushSubscription = Self(rawValue: "INVALID_PUSH_SUBSCRIPTION")
  public static let invalidAPNSDevice = Self(rawValue: "INVALID_APNS_DEVICE")
  public static let invalidRole = Self(rawValue: "INVALID_ROLE")
  public static let invalidRoomCode = Self(rawValue: "INVALID_ROOM_CODE")
  public static let invalidRequest = Self(rawValue: "INVALID_REQUEST")
  public static let inviteCodeLimit = Self(rawValue: "INVITE_CODE_LIMIT")
  public static let inviteInvalidOrExpired = Self(rawValue: "INVITE_INVALID_OR_EXPIRED")
  public static let inviteRateLimited = Self(rawValue: "INVITE_RATE_LIMITED")
  public static let inviteRoomUnavailable = Self(rawValue: "INVITE_ROOM_UNAVAILABLE")
  public static let lastAdmin = Self(rawValue: "LAST_ADMIN")
  public static let methodNotAllowed = Self(rawValue: "METHOD_NOT_ALLOWED")
  public static let missingHumanPlayer = Self(rawValue: "MISSING_HUMAN_PLAYER")
  public static let missingPushKeys = Self(rawValue: "MISSING_PUSH_KEYS")
  public static let passwordsMustMatch = Self(rawValue: "PASSWORDS_MUST_MATCH")
  public static let playerNotFound = Self(rawValue: "PLAYER_NOT_FOUND")
  public static let pushNotConfigured = Self(rawValue: "PUSH_NOT_CONFIGURED")
  public static let requestTooLarge = Self(rawValue: "REQUEST_TOO_LARGE")
  public static let requestFailed = Self(rawValue: "REQUEST_FAILED")
  public static let roomMembershipRequired = Self(rawValue: "ROOM_MEMBERSHIP_REQUIRED")
  public static let roomNotFound = Self(rawValue: "ROOM_NOT_FOUND")
  public static let serviceNotReady = Self(rawValue: "SERVICE_NOT_READY")
  public static let serviceUnavailable = Self(rawValue: "SERVICE_UNAVAILABLE")
  public static let statsClientUpgradeRequired = Self(rawValue: "STATS_CLIENT_UPGRADE_REQUIRED")
  public static let unsupportedMediaType = Self(rawValue: "UNSUPPORTED_MEDIA_TYPE")
  public static let weakPassword = Self(rawValue: "WEAK_PASSWORD")

  public let rawValue: String

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  public var isKnown: Bool {
    Self.knownCodes.contains(self)
  }

  private static let knownCodes: Set<Self> = [
    .accessRequired,
    .accessAuthenticationFailed,
    .accountAuthenticationFailed,
    .accountAuthenticationRequired,
    .accountRateLimited,
    .accountExists,
    .accountNotFound,
    .accountSessionChanged,
    .apnsDeviceLimit,
    .apnsNotConfigured,
    .apnsRegistrationRateLimited,
    .adminRequired,
    .adminSelfRevokeForbidden,
    .apiRouteNotFound,
    .codeAllocationFailed,
    .currentPasswordMismatch,
    .expectedJSONObject,
    .gameNotFound,
    .incompleteGame,
    .invalidCompletedAt,
    .invalidEmail,
    .invalidJSON,
    .invalidPushSubscription,
    .invalidAPNSDevice,
    .invalidRole,
    .invalidRoomCode,
    .invalidRequest,
    .inviteCodeLimit,
    .inviteInvalidOrExpired,
    .inviteRateLimited,
    .inviteRoomUnavailable,
    .lastAdmin,
    .methodNotAllowed,
    .missingHumanPlayer,
    .missingPushKeys,
    .passwordsMustMatch,
    .playerNotFound,
    .pushNotConfigured,
    .requestTooLarge,
    .requestFailed,
    .roomMembershipRequired,
    .roomNotFound,
    .serviceNotReady,
    .serviceUnavailable,
    .statsClientUpgradeRequired,
    .unsupportedMediaType,
    .weakPassword,
  ]
}

public enum SkyjoHTTPClientError: Error, Equatable, Sendable {
  case invalidHTTPResponse
  case invalidSuccessPayload
  case redirected
  case requestTooLarge(limit: Int)
  case responseTooLarge(limit: Int)
  case server(statusCode: Int, code: SkyjoAPIErrorCode?, message: String)
  case transport(URLError.Code)
  case unsupportedServerVersion

  public static let safeFallbackMessage = "Request failed."
}

extension SkyjoHTTPClientError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .invalidHTTPResponse, .invalidSuccessPayload:
      "The server returned an invalid response."
    case .redirected:
      "The server redirected a native API request."
    case .requestTooLarge:
      "The request is too large."
    case .responseTooLarge:
      "The server response is too large."
    case .server(_, _, let message):
      message
    case .transport:
      "The server could not be reached."
    case .unsupportedServerVersion:
      "Update Skyjo to connect to this server."
    }
  }
}

public enum SkyjoURLSessionFactory: Sendable {
  public static func makeDedicated(
    cookieStorage: HTTPCookieStorage = .shared,
    additionalHTTPHeaders: [String: String] = [:],
    protocolClasses: [AnyClass]? = nil
  ) -> URLSession {
    let configuration = URLSessionConfiguration.default
    configuration.httpCookieStorage = cookieStorage
    configuration.httpCookieAcceptPolicy = .always
    configuration.httpShouldSetCookies = true
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    if !additionalHTTPHeaders.isEmpty {
      configuration.httpAdditionalHeaders = additionalHTTPHeaders
    }
    if let protocolClasses {
      configuration.protocolClasses = protocolClasses
    }

    return URLSession(
      configuration: configuration,
      delegate: RedirectRejectingURLSessionDelegate(),
      delegateQueue: nil
    )
  }

  /// Creates a transport that can send explicitly attached cookies but can never
  /// accept response cookies on URLSession's behalf. Callers must validate a
  /// complete response before committing any parsed cookies to their shared jar.
  public static func makeCookieDisabled(copying sourceSession: URLSession? = nil) -> URLSession {
    let configuration = sourceSession?.configuration ?? .default
    configuration.httpCookieStorage = nil
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil

    return URLSession(
      configuration: configuration,
      delegate: RedirectRejectingURLSessionDelegate(),
      delegateQueue: nil
    )
  }
}

public actor AccessSessionClient {
  public static let maximumRequestBytes = 256 * 1024
  public static let maximumResponseBytes = 64 * 1024

  private let environment: SkyjoNetworkEnvironment
  private let session: URLSession
  private let cookieStorage: HTTPCookieStorage
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  public init(
    environment: SkyjoNetworkEnvironment,
    session: URLSession,
    cookieStorage: HTTPCookieStorage
  ) {
    self.environment = environment
    self.session = session
    self.cookieStorage = cookieStorage
  }

  public func status() async throws -> AccessSessionStatus {
    try await request(method: "GET")
  }

  public func login(password: String) async throws -> AccessSessionStatus {
    let body = try encoder.encode(AccessLoginRequest(password: password))
    guard body.count <= Self.maximumRequestBytes else {
      throw SkyjoHTTPClientError.requestTooLarge(limit: Self.maximumRequestBytes)
    }
    return try await request(method: "POST", body: body)
  }

  public func logout() async throws -> AccessSessionStatus {
    try await request(method: "DELETE")
  }

  private func request(method: String, body: Data? = nil) async throws -> AccessSessionStatus {
    let endpoint = environment.baseURL.appending(path: "api/access/session")
    var request = URLRequest(url: endpoint)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    if let body {
      request.httpBody = body
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

    if httpResponse.statusCode == 200 {
      guard Self.isJSONResponse(httpResponse) else {
        throw SkyjoHTTPClientError.invalidSuccessPayload
      }
      do {
        return try decoder.decode(AccessSessionStatus.self, from: data)
      } catch {
        throw SkyjoHTTPClientError.invalidSuccessPayload
      }
    }

    throw decodeServerError(statusCode: httpResponse.statusCode, response: httpResponse, data: data)
  }

  private func decodeServerError(
    statusCode: Int,
    response: HTTPURLResponse,
    data: Data
  ) -> SkyjoHTTPClientError {
    guard Self.isJSONResponse(response) else {
      return .server(statusCode: statusCode, code: nil, message: SkyjoHTTPClientError.safeFallbackMessage)
    }

    guard let payload = try? decoder.decode(SkyjoAPIErrorPayload.self, from: data) else {
      return .server(statusCode: statusCode, code: nil, message: SkyjoHTTPClientError.safeFallbackMessage)
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

private struct AccessLoginRequest: Encodable, Sendable {
  let password: String
}

private struct SkyjoAPIErrorPayload: Decodable, Sendable {
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

private final class RedirectRejectingURLSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
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

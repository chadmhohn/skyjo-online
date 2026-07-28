import Foundation

public enum RoomInviteContractError: Error, Equatable, Sendable {
  case invalidInviteURL
  case invalidInviteToken
  case invalidRoomCode
  case invalidExpiry
}

extension RoomInviteContractError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .invalidInviteURL, .invalidInviteToken:
      "This Skyjo invite link is invalid."
    case .invalidRoomCode, .invalidExpiry:
      "The server returned an invalid room invite."
    }
  }
}

/// An opaque signed invite token. Its printable representations are always redacted.
public struct RoomInviteToken: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  fileprivate let rawValue: String

  public init(_ rawValue: String) throws {
    guard Self.isValid(rawValue) else { throw RoomInviteContractError.invalidInviteToken }
    self.rawValue = rawValue
  }

  public var description: String { debugDescription }
  public var debugDescription: String { "RoomInviteToken(<redacted>)" }

  fileprivate static func isValid(_ value: String) -> Bool {
    let scalars = value.unicodeScalars
    guard !scalars.isEmpty, scalars.count <= 2_048 else { return false }
    var separatorIndex: Int?
    for (index, scalar) in scalars.enumerated() {
      if scalar == "." {
        guard separatorIndex == nil else { return false }
        separatorIndex = index
        continue
      }
      guard scalar.isASCII,
            scalar.properties.isAlphabetic || scalar.properties.numericType != nil
              || scalar == "_" || scalar == "-"
      else { return false }
    }
    guard let separatorIndex else { return false }
    return separatorIndex > 0 && separatorIndex < scalars.count - 1
  }
}

/// A validated production universal link. The URL and token are never printed.
public struct RoomInviteLink: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public static let productionHost = "skyjo.groundworkrevops.com"

  public let token: RoomInviteToken

  public init(url: URL) throws {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.scheme?.lowercased() == "https",
          components.host?.lowercased() == Self.productionHost,
          components.port == nil,
          components.user == nil,
          components.password == nil,
          components.query == nil,
          components.fragment == nil
    else { throw RoomInviteContractError.invalidInviteURL }

    let prefix = "/invite/"
    let path = components.percentEncodedPath
    guard path.hasPrefix(prefix), path.count > prefix.count else {
      throw RoomInviteContractError.invalidInviteURL
    }
    let tokenText = String(path.dropFirst(prefix.count))
    guard !tokenText.contains("/"), !tokenText.contains("%") else {
      throw RoomInviteContractError.invalidInviteURL
    }
    token = try RoomInviteToken(tokenText)
  }

  public var description: String { debugDescription }
  public var debugDescription: String { "RoomInviteLink(<redacted>)" }
}

public struct RedeemedRoomInvite: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let roomCode: String
  public let expiresAt: Int64

  public init(roomCode: String, expiresAt: Int64) throws {
    guard Self.isRoomCode(roomCode) else { throw RoomInviteContractError.invalidRoomCode }
    guard Self.isSafeEpochMilliseconds(expiresAt) else {
      throw RoomInviteContractError.invalidExpiry
    }
    self.roomCode = roomCode
    self.expiresAt = expiresAt
  }

  public func isExpired(at nowMilliseconds: Int64) -> Bool {
    expiresAt <= nowMilliseconds
  }

  public var description: String { debugDescription }
  public var debugDescription: String {
    "RedeemedRoomInvite(roomCode: <redacted>, expiresAt: <redacted>)"
  }

  fileprivate static func isRoomCode(_ value: String) -> Bool {
    value.count == 5 && value.unicodeScalars.allSatisfy {
      $0.isASCII && ($0.properties.numericType != nil || $0.properties.isUppercase)
    }
  }

  fileprivate static func isSafeEpochMilliseconds(_ value: Int64) -> Bool {
    (0...9_007_199_254_740_991).contains(value)
  }
}

public struct NativeRoomInvite: Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible {
  public let roomCode: String
  public let url: URL
  public let expiresAt: Int64

  fileprivate init(roomCode: String, url: URL, expiresAt: Int64) {
    self.roomCode = roomCode
    self.url = url
    self.expiresAt = expiresAt
  }

  public var description: String { debugDescription }
  public var debugDescription: String {
    "NativeRoomInvite(roomCode: <redacted>, url: <redacted>, expiresAt: <redacted>)"
  }
}

public actor RoomInviteClient {
  public static let maximumRequestBytes = 4 * 1_024
  public static let maximumResponseBytes = 64 * 1_024

  private let environment: SkyjoNetworkEnvironment
  private let session: URLSession
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  public init(environment: SkyjoNetworkEnvironment, session: URLSession) {
    self.environment = environment
    self.session = session
  }

  public init(
    environment: SkyjoNetworkEnvironment,
    persistentCookieStorage: HTTPCookieStorage = .shared
  ) {
    self.environment = environment
    session = SkyjoURLSessionFactory.makeDedicated(cookieStorage: persistentCookieStorage)
  }

  /// Redeems only the outer-access layer. Account authentication and room admission remain separate.
  public func redeem(_ link: RoomInviteLink) async throws -> RedeemedRoomInvite {
    let response: RedemptionResponse = try await request(
      path: "api/rooms/invite/redeem",
      body: RedemptionRequest(token: link.token.rawValue),
      requireNoStore: true
    )
    return try RedeemedRoomInvite(roomCode: response.roomCode, expiresAt: response.expiresAt)
  }

  public func create(roomCode: String) async throws -> NativeRoomInvite {
    guard RedeemedRoomInvite.isRoomCode(roomCode) else {
      throw RoomInviteContractError.invalidRoomCode
    }
    let response: CreationResponse = try await request(
      path: "api/rooms/invite",
      body: CreationRequest(roomCode: roomCode),
      requireNoStore: true
    )
    guard response.roomCode == roomCode,
          RedeemedRoomInvite.isSafeEpochMilliseconds(response.expiresAt)
    else { throw SkyjoHTTPClientError.invalidSuccessPayload }
    let token = try Self.token(fromInvitePath: response.path)
    guard let url = URL(string: response.path, relativeTo: environment.baseURL)?.absoluteURL,
          url.path == response.path,
          url.query == nil,
          url.fragment == nil
    else { throw SkyjoHTTPClientError.invalidSuccessPayload }
    _ = token
    return NativeRoomInvite(roomCode: roomCode, url: url, expiresAt: response.expiresAt)
  }

  private func request<Response: Decodable & Sendable, Body: Encodable & Sendable>(
    path: String,
    body: Body,
    requireNoStore: Bool
  ) async throws -> Response {
    let bodyData = try encoder.encode(body)
    guard bodyData.count <= Self.maximumRequestBytes else {
      throw SkyjoHTTPClientError.requestTooLarge(limit: Self.maximumRequestBytes)
    }
    let endpoint = environment.baseURL.appending(path: path)
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.httpBody = bodyData
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
    request.cachePolicy = .reloadIgnoringLocalCacheData

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
    guard httpResponse.url == endpoint, !(300..<400).contains(httpResponse.statusCode) else {
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
      guard Self.isJSON(httpResponse), !requireNoStore || Self.isNoStore(httpResponse) else {
        throw SkyjoHTTPClientError.invalidSuccessPayload
      }
      do {
        return try decoder.decode(Response.self, from: data)
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
    guard Self.isJSON(response),
          let payload = try? decoder.decode(InviteAPIErrorPayload.self, from: data)
    else {
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

  private static func token(fromInvitePath path: String) throws -> RoomInviteToken {
    let prefix = "/invite/"
    guard path.hasPrefix(prefix), path.count > prefix.count else {
      throw SkyjoHTTPClientError.invalidSuccessPayload
    }
    let tokenText = String(path.dropFirst(prefix.count))
    guard !tokenText.contains("/"), !tokenText.contains("%") else {
      throw SkyjoHTTPClientError.invalidSuccessPayload
    }
    do {
      return try RoomInviteToken(tokenText)
    } catch {
      throw SkyjoHTTPClientError.invalidSuccessPayload
    }
  }

  private static func isJSON(_ response: HTTPURLResponse) -> Bool {
    response.value(forHTTPHeaderField: "Content-Type")?
      .split(separator: ";", maxSplits: 1).first?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() == "application/json"
  }

  private static func isNoStore(_ response: HTTPURLResponse) -> Bool {
    response.value(forHTTPHeaderField: "Cache-Control")?
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
      .contains("no-store") == true
  }
}

private struct RedemptionRequest: Encodable, Sendable {
  let token: String
}

private struct RedemptionResponse: Decodable, Sendable {
  let roomCode: String
  let expiresAt: Int64
}

private struct CreationRequest: Encodable, Sendable {
  let roomCode: String
}

private struct CreationResponse: Decodable, Sendable {
  let roomCode: String
  let path: String
  let expiresAt: Int64
}

private struct InviteAPIErrorPayload: Decodable, Sendable {
  let code: String
  let error: String

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let code = try container.decode(String.self, forKey: .code)
    let error = try container.decode(String.self, forKey: .error)
    guard (1...128).contains(code.unicodeScalars.count),
          code.unicodeScalars.allSatisfy({
            $0 == "_" || $0.isASCII && ($0.properties.isUppercase || $0.properties.numericType != nil)
          }),
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

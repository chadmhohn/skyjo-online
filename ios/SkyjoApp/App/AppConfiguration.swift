import Foundation

struct AppConfiguration: Equatable, Sendable {
  static let apiBaseURLInfoKey = "SKYJO_API_BASE_URL"

  let apiBaseURL: URL

  init(infoDictionary: [String: Any]) throws {
    guard let rawValue = infoDictionary[Self.apiBaseURLInfoKey] as? String else {
      throw AppConfigurationError.missingValue(Self.apiBaseURLInfoKey)
    }

    let normalizedValue = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      let url = URL(string: normalizedValue),
      let scheme = url.scheme?.lowercased(),
      let host = url.host,
      !host.isEmpty,
      url.user == nil,
      url.password == nil
    else {
      throw AppConfigurationError.invalidBaseURL(rawValue)
    }

    guard scheme == "http" || scheme == "https" else {
      throw AppConfigurationError.unsupportedScheme(scheme)
    }

    apiBaseURL = url
  }

  init(bundle: Bundle) throws {
    try self.init(infoDictionary: bundle.infoDictionary ?? [:])
  }
}

enum AppConfigurationError: Error, Equatable, LocalizedError, Sendable {
  case missingValue(String)
  case invalidBaseURL(String)
  case unsupportedScheme(String)

  var errorDescription: String? {
    switch self {
    case .missingValue(let key):
      "The required build setting \(key) is missing."
    case .invalidBaseURL:
      "The configured service URL is invalid."
    case .unsupportedScheme:
      "The configured service URL must use HTTP or HTTPS."
    }
  }
}

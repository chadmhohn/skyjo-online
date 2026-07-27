import Foundation
import SkyjoTestSupport
import Testing
import UIKit

@testable import SkyjoNative

@Suite("Native bootstrap")
struct BootstrapTests {
  @Test("An absolute HTTP or HTTPS endpoint is accepted")
  func validBaseURL() throws {
    let httpsConfiguration = try AppConfiguration(infoDictionary: [
      AppConfiguration.apiBaseURLInfoKey: "https://skyjo.groundworkrevops.com"
    ])
    let localConfiguration = try AppConfiguration(infoDictionary: [
      AppConfiguration.apiBaseURLInfoKey: "http://127.0.0.1:4180"
    ])

    #expect(httpsConfiguration.apiBaseURL.scheme == "https")
    #expect(localConfiguration.apiBaseURL.host == "127.0.0.1")
  }

  @Test("Missing, relative, credentialed, and unsupported endpoints fail closed")
  func invalidBaseURLs() {
    expectConfigurationError(.missingValue(AppConfiguration.apiBaseURLInfoKey), for: [:])
    expectConfigurationError(
      .invalidBaseURL("/relative"),
      for: [AppConfiguration.apiBaseURLInfoKey: "/relative"]
    )
    expectConfigurationError(
      .invalidBaseURL("https://user:password@example.com"),
      for: [AppConfiguration.apiBaseURLInfoKey: "https://user:password@example.com"]
    )
    expectConfigurationError(
      .unsupportedScheme("ftp"),
      for: [AppConfiguration.apiBaseURLInfoKey: "ftp://example.com"]
    )
  }

  @Test("The local package graph compiles without a cycle")
  func packageGraph() {
    #expect(
      NativePackageGraph.moduleNames == [
        "SkyjoDomain",
        "SkyjoNetworking",
        "SkyjoPersistence",
        "SkyjoDesignSystem",
        "SkyjoTestSupport",
      ])
    #expect(NativePackageGraph.directDependencies["SkyjoDomain"] == [])
    #expect(NativePackageGraph.directDependencies["SkyjoNetworking"] == ["SkyjoDomain"])
    #expect(NativePackageGraph.directDependencies["SkyjoPersistence"] == ["SkyjoDomain"])
    #expect(NativePackageGraph.directDependencies["SkyjoDesignSystem"] == [])
  }

  @Test("Build settings and required resources are embedded")
  @MainActor
  func embeddedConfigurationAndResources() throws {
    let configuration = try AppConfiguration(bundle: .main)
    #expect(configuration.apiBaseURL.scheme == "http" || configuration.apiBaseURL.scheme == "https")
    #expect(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy") != nil)
    #expect(UIColor(named: "AccentColor", in: .main, compatibleWith: nil) != nil)
  }

  private func expectConfigurationError(
    _ expectedError: AppConfigurationError,
    for infoDictionary: [String: Any]
  ) {
    do {
      _ = try AppConfiguration(infoDictionary: infoDictionary)
      Issue.record("Expected configuration to fail")
    } catch let error as AppConfigurationError {
      #expect(error == expectedError)
    } catch {
      Issue.record("Unexpected error: \(error)")
    }
  }
}

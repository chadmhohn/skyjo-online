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

  @Test("Debug test-server overrides are limited to HTTP loopback")
  func testServerOverride() throws {
#if DEBUG
    let configuration = try AppConfiguration(
      bundle: .main,
      processEnvironment: [AppConfiguration.testServerURLEnvironmentKey: "http://127.0.0.1:43123"]
    )
    #expect(configuration.apiBaseURL.absoluteString == "http://127.0.0.1:43123")

    do {
      _ = try AppConfiguration(
        bundle: .main,
        processEnvironment: [AppConfiguration.testServerURLEnvironmentKey: "https://example.com"]
      )
      Issue.record("Expected a non-loopback test override to fail closed.")
    } catch let error as AppConfigurationError {
      #expect(error == .invalidBaseURL("https://example.com"))
    } catch {
      Issue.record("Unexpected error type for a non-loopback test override.")
    }
#endif
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

  @Test("The embedded privacy manifest matches the accessed API and collected data inventory")
  func privacyManifestDataInventory() throws {
    let url = try #require(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
    let data = try Data(contentsOf: url)
    let root = try #require(
      PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    )
    let entries = try #require(root["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
    let accessedAPIEntries = try #require(root["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
    let accessedAPIReasons: [String: [String]] = Dictionary(
      uniqueKeysWithValues: accessedAPIEntries.compactMap { entry -> (String, [String])? in
        guard
          let category = entry["NSPrivacyAccessedAPIType"] as? String,
          let reasons = entry["NSPrivacyAccessedAPITypeReasons"] as? [String]
        else {
          return nil
        }
        return (category, reasons)
      })
    #expect(
      accessedAPIReasons == [
        "NSPrivacyAccessedAPICategoryUserDefaults": ["CA92.1"],
        "NSPrivacyAccessedAPICategoryFileTimestamp": ["C617.1"],
      ])
    let expectedTypes: Set<String> = [
      "NSPrivacyCollectedDataTypeName",
      "NSPrivacyCollectedDataTypeEmailAddress",
      "NSPrivacyCollectedDataTypeEmailsOrTextMessages",
      "NSPrivacyCollectedDataTypeGameplayContent",
      "NSPrivacyCollectedDataTypeUserID",
      "NSPrivacyCollectedDataTypeDeviceID",
      "NSPrivacyCollectedDataTypeProductInteraction",
      "NSPrivacyCollectedDataTypeOtherDataTypes",
    ]

    #expect(entries.count == expectedTypes.count)
    #expect(Set(entries.compactMap { $0["NSPrivacyCollectedDataType"] as? String }) == expectedTypes)
    #expect(entries.allSatisfy { $0["NSPrivacyCollectedDataTypeLinked"] as? Bool == true })
    #expect(entries.allSatisfy { $0["NSPrivacyCollectedDataTypeTracking"] as? Bool == false })
    #expect(entries.allSatisfy {
      ($0["NSPrivacyCollectedDataTypePurposes"] as? [String])
        == ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
    })
    #expect(root["NSPrivacyTracking"] as? Bool == false)
    #expect((root["NSPrivacyTrackingDomains"] as? [String])?.isEmpty == true)
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

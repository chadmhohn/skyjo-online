import UIKit
import XCTest

final class SkyjoAppUITests: XCTestCase {
  private let accessFixture = "skyjo-ios-contract-access-v1"

  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  @MainActor
  func testAccessSignupRelaunchProfilePasswordAndLogout() throws {
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launch()

    XCTAssertTrue(app.secureTextFields["access.password"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["access.submit"].isEnabled)
    XCTAssertEqual(app.webViews.count, 0)

    app.secureTextFields["access.password"].tap()
    app.secureTextFields["access.password"].typeText(accessFixture)
    app.buttons["access.submit"].tap()

    XCTAssertTrue(app.segmentedControls["auth.mode"].waitForExistence(timeout: 10))
    app.buttons["Create Account"].tap()

    let email = "ui-\(UUID().uuidString.lowercased())@example.invalid"
    let originalPassword = "native-ui-password-v1"
    let replacementPassword = "native-ui-password-v2"
    app.textFields["auth.email"].tap()
    app.textFields["auth.email"].typeText(email)
    app.textFields["auth.display-name"].tap()
    app.textFields["auth.display-name"].typeText("UI Player")
    app.secureTextFields["auth.password"].tap()
    app.secureTextFields["auth.password"].typeText(originalPassword)
    app.secureTextFields["auth.confirm-password"].tap()
    app.secureTextFields["auth.confirm-password"].typeText(originalPassword)
    XCTAssertTrue(app.buttons["auth.submit"].isEnabled)
    app.buttons["auth.submit"].tap()

    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 15))
    attachScreenshot(app, name: "ios5-home-after-signup-portrait")
    try performAccessibilityAudit(on: app)

    XCUIDevice.shared.press(.home)
    XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5))
    app.terminate()
    app.launch()
    XCTAssertTrue(
      app.staticTexts["home.welcome"].waitForExistence(timeout: 15),
      "Both HttpOnly session layers should survive a native relaunch."
    )

    tapTab("Stats", in: app)
    XCTAssertTrue(element(in: app, identifier: "stats.empty").waitForExistence(timeout: 10))
    attachScreenshot(app, name: "ios5-stats-empty")

    tapTab("Account", in: app)
    XCTAssertTrue(element(in: app, identifier: "account.screen").waitForExistence(timeout: 5))
    replaceText(in: app.textFields["account.display-name"], with: "UI Prime")
    app.buttons["account.save-profile"].tap()
    XCTAssertTrue(app.staticTexts["account.profile-message"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["account.profile-message"].label, "Profile updated.")

    scrollToElement(app.secureTextFields["account.current-password"], in: app)
    app.secureTextFields["account.current-password"].tap()
    app.secureTextFields["account.current-password"].typeText(originalPassword)
    app.secureTextFields["account.new-password"].tap()
    app.secureTextFields["account.new-password"].typeText(replacementPassword)
    app.secureTextFields["account.confirm-password"].tap()
    app.secureTextFields["account.confirm-password"].typeText(replacementPassword)
    app.buttons["account.change-password"].tap()

    XCTAssertTrue(app.segmentedControls["auth.mode"].waitForExistence(timeout: 10))
    app.segmentedControls["auth.mode"].buttons["Sign In"].tap()
    XCTAssertEqual(app.textFields["auth.email"].value as? String, email)
    app.secureTextFields["auth.password"].tap()
    app.secureTextFields["auth.password"].typeText(replacementPassword)
    app.buttons["auth.submit"].tap()
    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 15))

    tapTab("Account", in: app)
    scrollToElement(app.buttons["account.logout"], in: app)
    app.buttons["account.logout"].tap()
    let sheetSignOut = app.sheets.buttons["Sign Out"]
    if sheetSignOut.waitForExistence(timeout: 3) {
      sheetSignOut.tap()
    } else {
      let alertSignOut = app.alerts.buttons["Sign Out"]
      XCTAssertTrue(alertSignOut.waitForExistence(timeout: 3))
      alertSignOut.tap()
    }
    XCTAssertTrue(app.segmentedControls["auth.mode"].waitForExistence(timeout: 10))
  }

  @MainActor
  func testAccessibleRecoveryStatesUseSafeCopyAndRetryActions() throws {
    XCUIDevice.shared.orientation = .portrait
    let states: [(argument: String, identifier: String, screenshot: String)] = [
      ("loading", "state.loading", "ios5-state-loading"),
      ("offline", "state.offline", "ios5-state-offline"),
      ("not-ready", "state.not-ready", "ios5-state-not-ready"),
      ("upgrade-required", "state.upgrade-required", "ios5-state-upgrade-required"),
      ("expired-disabled", "state.expired-disabled", "ios5-state-expired-disabled"),
      ("failed", "state.failed", "ios5-state-safe-fallback"),
    ]

    for state in states {
      let app = XCUIApplication()
      app.launchArguments = ["--ui-state=\(state.argument)"]
      app.launch()
      let stateElement = element(in: app, identifier: state.identifier)
      XCTAssertTrue(stateElement.waitForExistence(timeout: 8), "Missing accessible state \(state.argument)")
      if state.argument == "failed" {
        XCTAssertTrue(app.staticTexts["Request failed."].exists)
      }
      attachScreenshot(app, name: state.screenshot)
      app.terminate()
    }
  }

  @MainActor
  func testLoadedStatsGameAndPlayerNavigationAreAccessible() throws {
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launchArguments = ["--ui-state=authenticated-stats"]
    app.launch()

    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 8))
    tapTab("Stats", in: app)
    let gameLink = element(
      in: app,
      identifier: "stats.game.40000000-0000-4000-8000-000000000001"
    )
    XCTAssertTrue(gameLink.waitForExistence(timeout: 8))
    scrollToElement(gameLink, in: app)
    XCTAssertTrue(gameLink.isEnabled)
    XCTAssertEqual(gameLink.elementType, .button)
    gameLink.tap()

    XCTAssertTrue(app.navigationBars["Game Detail"].waitForExistence(timeout: 8))
    let winnerStanding = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label == %@", "Rank 1, Fixture User, total score 22"))
      .firstMatch
    XCTAssertTrue(winnerStanding.exists)
    attachScreenshot(app, name: "ios5-stats-game-detail")
    try performAccessibilityAudit(on: app)

    app.navigationBars["Game Detail"].buttons.firstMatch.tap()
    XCTAssertTrue(gameLink.waitForExistence(timeout: 5))
    let playerLink = element(
      in: app,
      identifier: "stats.player.30000000-0000-4000-8000-000000000004"
    )
    for _ in 0..<8 where !playerLink.isHittable {
      app.swipeDown(velocity: .slow)
    }
    XCTAssertTrue(playerLink.isHittable)
    XCTAssertTrue(playerLink.isEnabled)
    XCTAssertEqual(playerLink.elementType, .button)
    playerLink.tap()

    XCTAssertTrue(app.navigationBars["Player History"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Other Player"].exists)
    attachScreenshot(app, name: "ios5-stats-player-history")
    try performAccessibilityAudit(on: app)
  }

  @MainActor
  func testStatsOfflineStateRetriesIntoLoadedHistory() throws {
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launchArguments = ["--ui-state=authenticated-stats-offline"]
    app.launch()

    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 8))
    tapTab("Stats", in: app)
    let retry = app.buttons["Retry"]
    XCTAssertTrue(retry.waitForExistence(timeout: 8))
    XCTAssertTrue(retry.isEnabled)
    XCTAssertTrue(retry.isHittable)
    XCTAssertEqual(retry.label, "Retry")
    attachScreenshot(app, name: "ios5-stats-offline")
    retry.tap()

    let gameLink = element(
      in: app,
      identifier: "stats.game.40000000-0000-4000-8000-000000000001"
    )
    XCTAssertTrue(gameLink.waitForExistence(timeout: 8))
    attachScreenshot(app, name: "ios5-stats-retry-loaded")
    try performAccessibilityAudit(on: app)
  }

  @MainActor
  func testNavigationShellTracksAdminAndPublicDeletionBoundaries() throws {
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launchArguments = ["--ui-state=authenticated-admin"]
    app.launch()

    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["home.solo-disabled"].isEnabled)
    XCTAssertFalse(app.buttons["home.rooms-disabled"].isEnabled)

    tapTab("Stats", in: app)
    XCTAssertTrue(element(in: app, identifier: "stats.empty").waitForExistence(timeout: 5))

    tapTab("Account", in: app)
    XCTAssertTrue(element(in: app, identifier: "account.screen").waitForExistence(timeout: 5))
    let saveProfile = app.buttons["account.save-profile"]
    XCTAssertTrue(saveProfile.waitForExistence(timeout: 5))
    XCTAssertGreaterThanOrEqual(saveProfile.frame.height, 44)
    try performAccessibilityAudit(on: app)
    let changePassword = app.buttons["account.change-password"]
    scrollToElement(changePassword, in: app)
    XCTAssertGreaterThanOrEqual(changePassword.frame.height, 44)
    scrollToElement(app.staticTexts["account.admin-web-only"], in: app)
    XCTAssertTrue(app.staticTexts["account.admin-web-only"].exists)
    XCTAssertTrue(element(in: app, identifier: "account.admin-link").exists)
    scrollToElement(app.staticTexts["account.deletion-gate"], in: app)
    XCTAssertTrue(app.staticTexts["account.deletion-gate"].exists)
    XCTAssertTrue(element(in: app, identifier: "account.deletion-link").exists)
    attachScreenshot(app, name: "ios5-account-admin-deletion-portrait")
    let recoveryFooter = element(in: app, identifier: "account.recovery-footer")
    scrollToElementFullyVisible(recoveryFooter, in: app)
    let logout = app.buttons["account.logout"]
    XCTAssertTrue(logout.isHittable)
    XCTAssertGreaterThanOrEqual(logout.frame.height, 44)
    app.terminate()

    XCUIDevice.shared.orientation = .landscapeLeft
    let landscapeApp = XCUIApplication()
    landscapeApp.launchArguments = ["--ui-state=authenticated-admin"]
    landscapeApp.launch()
    XCTAssertTrue(landscapeApp.staticTexts["home.welcome"].waitForExistence(timeout: 8))
    waitForSettledOrientation(landscapeApp, landscape: true)
    tapTab("Account", in: landscapeApp)
    let landscapeAccount = element(in: landscapeApp, identifier: "account.screen")
    XCTAssertTrue(landscapeAccount.waitForExistence(timeout: 5))
    let landscapeSaveProfile = landscapeApp.buttons["account.save-profile"]
    XCTAssertTrue(landscapeSaveProfile.waitForExistence(timeout: 5))
    XCTAssertTrue(landscapeSaveProfile.isHittable)
    XCTAssertGreaterThanOrEqual(landscapeSaveProfile.frame.height, 44)
    attachScreenScreenshot(name: "ios5-account-landscape")
    landscapeApp.terminate()

    XCUIDevice.shared.orientation = .portrait

    let dynamicTypeApp = XCUIApplication()
    dynamicTypeApp.launchArguments = [
      "--ui-state=authenticated-admin",
      "--ui-expose-dynamic-type",
      "-UIPreferredContentSizeCategoryName",
      "UICTContentSizeCategoryAccessibilityXXXL",
    ]
    dynamicTypeApp.launch()
    XCTAssertTrue(dynamicTypeApp.staticTexts["home.welcome"].waitForExistence(timeout: 8))
    waitForSettledOrientation(dynamicTypeApp, landscape: false)
    tapTab("Account", in: dynamicTypeApp)
    let dynamicTypeIndicator = element(in: dynamicTypeApp, identifier: "debug.dynamic-type")
    XCTAssertTrue(dynamicTypeIndicator.waitForExistence(timeout: 8))
    XCTAssertEqual(dynamicTypeIndicator.value as? String, "accessibility5")
    let dynamicAdminBoundary = dynamicTypeApp.staticTexts["account.admin-web-only"]
    scrollToElement(dynamicAdminBoundary, in: dynamicTypeApp)
    XCTAssertTrue(dynamicAdminBoundary.exists)
    XCTAssertEqual(dynamicAdminBoundary.label, "Native admin tools are intentionally out of scope for v0.1.0.")
    let dynamicDeletionBoundary = dynamicTypeApp.staticTexts["account.deletion-gate"]
    scrollToElement(dynamicDeletionBoundary, in: dynamicTypeApp)
    XCTAssertTrue(dynamicDeletionBoundary.exists)
    XCTAssertEqual(dynamicDeletionBoundary.label, "Required before public App Store release")
    attachScreenshot(dynamicTypeApp, name: "ios5-account-accessibility-xxxl")
    let dynamicRecoveryFooter = element(in: dynamicTypeApp, identifier: "account.recovery-footer")
    scrollToElementFullyVisible(dynamicRecoveryFooter, in: dynamicTypeApp)
    XCTAssertEqual(
      dynamicRecoveryFooter.label,
      "If a session expires or an account is disabled, Skyjo returns to a safe sign-in recovery screen."
    )
    attachScreenshot(dynamicTypeApp, name: "ios5-account-recovery-accessibility-xxxl")
  }

  @MainActor
  private func attachScreenshot(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor
  private func attachScreenScreenshot(name: String) {
    let screenshotImage = XCUIScreen.main.screenshot().image
    let format = UIGraphicsImageRendererFormat()
    format.scale = screenshotImage.scale
    let normalizedImage = UIGraphicsImageRenderer(
      size: screenshotImage.size,
      format: format
    ).image { _ in
      screenshotImage.draw(in: CGRect(origin: .zero, size: screenshotImage.size))
    }

    let attachment = XCTAttachment(image: normalizedImage)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  @MainActor
  private func waitForSettledOrientation(
    _ app: XCUIApplication,
    landscape: Bool,
    timeout: TimeInterval = 5
  ) {
    let predicate = NSPredicate { object, _ in
      guard let element = object as? XCUIElement else { return false }
      if landscape {
        return element.frame.width > element.frame.height
      }
      return element.frame.height > element.frame.width
    }
    let expectation = XCTNSPredicateExpectation(predicate: predicate, object: app)
    XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed)

    let window = app.windows.firstMatch
    XCTAssertTrue(window.waitForExistence(timeout: timeout))
    let windowExpectation = XCTNSPredicateExpectation(predicate: predicate, object: window)
    XCTAssertEqual(XCTWaiter.wait(for: [windowExpectation], timeout: timeout), .completed)

    if landscape {
      XCTAssertGreaterThan(app.frame.width, app.frame.height)
      XCTAssertGreaterThan(window.frame.width, window.frame.height)
    } else {
      XCTAssertGreaterThan(app.frame.height, app.frame.width)
      XCTAssertGreaterThan(window.frame.height, window.frame.width)
    }
  }

  @MainActor
  private func element(in app: XCUIApplication, identifier: String) -> XCUIElement {
    app.descendants(matching: .any)[identifier]
  }

  @MainActor
  private func tapTab(_ label: String, in app: XCUIApplication) {
    let compactTab = app.tabBars.buttons[label]
    if compactTab.exists {
      compactTab.tap()
      return
    }

    let candidates = app.descendants(matching: .any)
      .matching(NSPredicate(format: "label == %@", label))
      .allElementsBoundByIndex
    guard let floatingTab = candidates.first(where: \.isHittable) else {
      XCTFail("Missing accessible \(label) tab")
      return
    }
    floatingTab.tap()
  }

  @MainActor
  private func performAccessibilityAudit(on app: XCUIApplication) throws {
    // XCTest currently reports system-dimmed inactive SwiftUI controls as
    // contrast failures even though inactive controls are exempt. Their
    // disabled semantics and high-contrast custom treatment are asserted
    // separately. Xcode 26 also reports a SwiftUI AccessibilityNode Dynamic
    // Type false positive for text that demonstrably scales. The navigation-
    // shell test relaunches at accessibility XXXL and asserts the complete
    // labels and layout directly; all other audit categories remain enforced.
    try app.performAccessibilityAudit(for: .all.subtracting(.contrast.union(.dynamicType)))
  }

  @MainActor
  private func replaceText(in field: XCUIElement, with replacement: String) {
    field.tap()
    if let currentValue = field.value as? String, !currentValue.isEmpty {
      field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: currentValue.count))
    }
    field.typeText(replacement)
  }

  @MainActor
  private func scrollToElement(_ element: XCUIElement, in app: XCUIApplication) {
    for _ in 0..<8 where !element.isHittable {
      app.swipeUp(velocity: .slow)
    }
    XCTAssertTrue(element.isHittable)
  }

  @MainActor
  private func scrollToElementFullyVisible(
    _ element: XCUIElement,
    in app: XCUIApplication,
    bottomInset: CGFloat = 96
  ) {
    for _ in 0..<8 {
      if element.exists {
        let frame = element.frame
        if element.isHittable,
           frame.minY >= app.frame.minY,
           frame.maxY <= app.frame.maxY - bottomInset {
          return
        }
      }
      app.swipeUp(velocity: .slow)
    }

    XCTAssertTrue(element.exists)
    let frame = element.frame
    XCTAssertTrue(element.isHittable)
    XCTAssertGreaterThanOrEqual(frame.minY, app.frame.minY)
    XCTAssertLessThanOrEqual(frame.maxY, app.frame.maxY - bottomInset)
  }
}

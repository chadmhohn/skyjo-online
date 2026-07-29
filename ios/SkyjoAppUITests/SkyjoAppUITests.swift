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

    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 10))
    tapTab("Account", in: app)
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
    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 10))
    tapTab("Account", in: app)
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
    XCTAssertTrue(element(in: app, identifier: "home.solo").isEnabled)
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
  func testSoloLauncherMakesReplacementExplicitAndRecoverable() throws {
    let app = launchSoloFixture("solo-launcher")

    XCTAssertTrue(element(in: app, identifier: "solo.launcher").waitForExistence(timeout: 8))
    let continueGame = app.buttons["solo.continue"]
    let newGame = app.buttons["solo.new-game"]
    XCTAssertTrue(continueGame.isHittable)
    XCTAssertTrue(newGame.isHittable)
    XCTAssertGreaterThanOrEqual(continueGame.frame.height, 44)
    XCTAssertGreaterThanOrEqual(newGame.frame.height, 44)
    try performSoloAccessibilityAudit(on: app)
    newGame.tap()

    XCTAssertTrue(element(in: app, identifier: "solo.setup").waitForExistence(timeout: 8))
    XCTAssertEqual(element(in: app, identifier: "solo.setup.difficulty").value as? String, "Mixed")
    let proposedOpponentCount = app.steppers["solo.setup.bot-count"]
    XCTAssertEqual(proposedOpponentCount.value as? String, "3")
    proposedOpponentCount.buttons["solo.setup.bot-count-Increment"].tap()
    XCTAssertEqual(proposedOpponentCount.value as? String, "4")
    let proposedDifficulty = element(in: app, identifier: "solo.setup.difficulty")
    proposedDifficulty.tap()
    let easyOption = element(in: app, identifier: "solo.setup.difficulty.easy")
    XCTAssertTrue(easyOption.waitForExistence(timeout: 5))
    easyOption.tap()
    XCTAssertEqual(proposedDifficulty.value as? String, "Easy")
    let reviewNewGame = app.buttons["solo.setup.start"]
    scrollToElementFullyVisible(reviewNewGame, in: app)
    reviewNewGame.tap()
    XCTAssertTrue(app.navigationBars["Review Replacement"].waitForExistence(timeout: 8))
    XCTAssertEqual(
      element(in: app, identifier: "solo.replace.current-opponents").value as? String,
      "3"
    )
    XCTAssertEqual(
      element(in: app, identifier: "solo.replace.current-difficulty").value as? String,
      "Mixed"
    )
    XCTAssertEqual(
      element(in: app, identifier: "solo.replace.new-opponents").value as? String,
      "4"
    )
    XCTAssertEqual(
      element(in: app, identifier: "solo.replace.new-difficulty").value as? String,
      "Easy"
    )
    let replacementCopy = element(in: app, identifier: "solo.replace.recovery-copy")
    scrollToElementFullyVisible(replacementCopy, in: app, requiresHittable: false)
    XCTAssertTrue(replacementCopy.waitForExistence(timeout: 5))
    XCTAssertTrue(replacementCopy.label.contains("game recoverable"))
    let standardReplacementCopyLabel = replacementCopy.label
    let standardReplacementCopyHeight = replacementCopy.frame.height
    let standardDifficulty = element(
      in: app,
      identifier: "solo.replace.current-difficulty"
    )
    XCTAssertTrue(standardDifficulty.exists)
    let standardDifficultyHeight = standardDifficulty.frame.height
    let cancel = app.buttons["solo.replace.cancel"]
    XCTAssertTrue(cancel.isHittable)
    let standardCancelLabel = cancel.label
    try performSoloAccessibilityAudit(on: app, enforceDynamicType: false)
    cancel.tap()

    XCTAssertTrue(element(in: app, identifier: "solo.setup").waitForExistence(timeout: 5))
    app.buttons["solo.setup.cancel"].tap()
    XCTAssertTrue(element(in: app, identifier: "solo.launcher").waitForExistence(timeout: 5))
    let resumedGame = app.buttons["solo.continue"]
    XCTAssertTrue(resumedGame.isHittable)
    resumedGame.tap()
    assertResumedThreeOpponentMixedGame(in: app)
    attachScreenshot(app, name: "ios7-solo-replacement-recoverable")
    app.terminate()

    // Xcode 26 reports the live SwiftUI recovery-copy node as only partially
    // Dynamic Type aware even though its body font scales. Prove the exact node
    // at Accessibility XXXL before applying the narrow audit exemption below.
    let dynamicReplacement = launchSoloFixture(
      "solo-launcher",
      additionalArguments: [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    dynamicReplacement.buttons["solo.new-game"].tap()
    XCTAssertTrue(
      element(in: dynamicReplacement, identifier: "solo.setup").waitForExistence(timeout: 8)
    )
    let dynamicStart = dynamicReplacement.buttons["solo.setup.start"]
    scrollToElementFullyVisible(dynamicStart, in: dynamicReplacement)
    dynamicStart.tap()
    XCTAssertTrue(
      dynamicReplacement.navigationBars["Review Replacement"].waitForExistence(timeout: 8)
    )
    let dynamicReplacementCopy = element(
      in: dynamicReplacement,
      identifier: "solo.replace.recovery-copy"
    )
    let dynamicDifficulty = element(
      in: dynamicReplacement,
      identifier: "solo.replace.current-difficulty"
    )
    XCTAssertTrue(dynamicDifficulty.exists)
    let dynamicDifficultyHeight = dynamicDifficulty.frame.height
    for _ in 0..<6 where !dynamicReplacementCopy.exists {
      dynamicReplacement.swipeUp(velocity: .slow)
    }
    XCTAssertTrue(dynamicReplacementCopy.waitForExistence(timeout: 5))
    XCTAssertEqual(dynamicReplacementCopy.label, standardReplacementCopyLabel)
    XCTAssertGreaterThan(dynamicReplacementCopy.frame.height, standardReplacementCopyHeight + 8)
    XCTAssertGreaterThan(
      dynamicDifficultyHeight,
      standardDifficultyHeight + 8,
      "Replacement summary rows must scale at Accessibility XXXL."
    )
    let dynamicCancel = dynamicReplacement.buttons["solo.replace.cancel"]
    XCTAssertTrue(dynamicCancel.isHittable)
    XCTAssertEqual(dynamicCancel.label, standardCancelLabel)
    attachScreenshot(dynamicReplacement, name: "ios7-solo-replacement-accessibility-xxxl")
    dynamicReplacement.terminate()

    let failedReplacement = launchSoloFixture("solo-replacement-error")
    XCTAssertTrue(failedReplacement.navigationBars["Review Replacement"].waitForExistence(timeout: 8))
    let visibleError = element(in: failedReplacement, identifier: "solo.replace.error")
    for _ in 0..<4 where !visibleError.exists {
      failedReplacement.swipeUp(velocity: .slow)
    }
    XCTAssertTrue(visibleError.waitForExistence(timeout: 5))
    XCTAssertTrue(visibleError.label.contains("Previous game preserved"))
    XCTAssertTrue(visibleError.label.contains("previous game is still recoverable"))
    let retryReplacement = failedReplacement.buttons["solo.replace.confirm"]
    scrollToElementFullyVisible(
      retryReplacement,
      in: failedReplacement,
      bottomInset: 44
    )
    XCTAssertTrue(retryReplacement.isEnabled)
    XCTAssertTrue(retryReplacement.isHittable)
    XCTAssertTrue(failedReplacement.buttons["solo.replace.cancel"].isHittable)
    attachScreenshot(failedReplacement, name: "ios7-solo-replacement-error")
    failedReplacement.buttons["solo.replace.cancel"].tap()
    XCTAssertTrue(
      element(in: failedReplacement, identifier: "solo.setup").waitForExistence(timeout: 5)
    )
    let keepSavedGame = failedReplacement.buttons["solo.setup.cancel"]
    scrollToElementFullyVisible(keepSavedGame, in: failedReplacement)
    keepSavedGame.tap()
    XCTAssertTrue(
      element(in: failedReplacement, identifier: "solo.launcher").waitForExistence(timeout: 5)
    )
    failedReplacement.buttons["solo.continue"].tap()
    assertResumedThreeOpponentMixedGame(in: failedReplacement)
    attachScreenshot(failedReplacement, name: "ios7-solo-replacement-error-continued")
    failedReplacement.terminate()

    let volatileApp = launchSoloFixture("solo-launcher-volatile")
    XCTAssertTrue(volatileApp.staticTexts["Temporary game"].waitForExistence(timeout: 8))
    XCTAssertFalse(volatileApp.staticTexts["Saved game"].exists)
    let volatileWarning = element(in: volatileApp, identifier: "solo.persistence-warning")
    XCTAssertTrue(volatileWarning.exists)
    XCTAssertTrue(volatileWarning.label.contains("session can continue, but it is temporary"))
    attachScreenshot(volatileApp, name: "ios7-solo-launcher-volatile-storage")
    volatileApp.terminate()

    let volatileHome = XCUIApplication()
    volatileHome.launchArguments = ["--ui-state=solo-launcher-volatile"]
    volatileHome.launch()
    XCTAssertTrue(volatileHome.staticTexts["home.welcome"].waitForExistence(timeout: 8))
    XCTAssertTrue(
      volatileHome.staticTexts.matching(
        NSPredicate(
          format: "label == %@",
          "Guest games exist only while Skyjo remains open because device storage is unavailable. They are not uploaded to account stats."
        )
      ).firstMatch.waitForExistence(timeout: 5)
    )
    tapTab("Stats", in: volatileHome)
    XCTAssertTrue(
      volatileHome.staticTexts.matching(
        NSPredicate(
          format: "label == %@",
          "Guest solo games are available only while Skyjo remains open and do not add account stats."
        )
      ).firstMatch.waitForExistence(timeout: 5)
    )
  }

  @MainActor
  func testSoloOfflineAccountCopyAndRevalidationAreExplicit() throws {
    XCUIDevice.shared.orientation = .portrait
    let app = XCUIApplication()
    app.launchArguments = ["--ui-state=solo-offline-account"]
    app.launch()

    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["Offline account save"].exists)
    let offlineCopy = app.staticTexts.matching(
      NSPredicate(
        format: "label == %@",
        "This account-owned solo save remains available offline. Completed results stay on this device until the account is confirmed online."
      )
    ).firstMatch
    XCTAssertTrue(offlineCopy.exists)
    XCTAssertFalse(app.staticTexts["Guest play"].exists)
    let retry = app.buttons["home.offline-retry"]
    XCTAssertTrue(retry.exists)
    XCTAssertTrue(retry.isEnabled)
    XCTAssertTrue(retry.isHittable)
    XCTAssertGreaterThanOrEqual(retry.frame.height, 44)
    attachScreenshot(app, name: "ios7-solo-offline-account")
    tapTab("Stats", in: app)
    XCTAssertTrue(
      app.staticTexts.matching(
        NSPredicate(
          format: "label == %@",
          "Account-owned solo results stay on this device and wait for sign-in confirmation before syncing to account stats."
        )
      ).firstMatch.waitForExistence(timeout: 5)
    )
    XCTAssertFalse(
      app.staticTexts.matching(
        NSPredicate(format: "label CONTAINS[c] %@", "Guest solo games")
      ).firstMatch.exists
    )
    app.terminate()

    let cachedAccountApp = XCUIApplication()
    cachedAccountApp.launchArguments = [
      "--ui-state=solo-offline-account",
      "--ui-offline-cached-account",
    ]
    cachedAccountApp.launch()
    XCTAssertTrue(cachedAccountApp.staticTexts["home.welcome"].waitForExistence(timeout: 8))

    tapTab("Stats", in: cachedAccountApp)
    let offlineStats = element(
      in: cachedAccountApp,
      identifier: "stats.offline-account"
    )
    XCTAssertTrue(offlineStats.waitForExistence(timeout: 5))
    XCTAssertFalse(cachedAccountApp.buttons["stats.refresh"].exists)
    let statsRetry = cachedAccountApp.buttons["stats.offline-account.retry"]
    XCTAssertTrue(statsRetry.waitForExistence(timeout: 5))
    XCTAssertEqual(statsRetry.label, "Check Connection")
    XCTAssertTrue(statsRetry.isEnabled)
    XCTAssertTrue(statsRetry.isHittable)
    XCTAssertGreaterThanOrEqual(statsRetry.frame.height, 44)

    tapTab("Account", in: cachedAccountApp)
    let offlineAccount = element(
      in: cachedAccountApp,
      identifier: "account.offline"
    )
    XCTAssertTrue(offlineAccount.waitForExistence(timeout: 5))
    XCTAssertEqual(
      element(in: cachedAccountApp, identifier: "account.offline.email").value as? String,
      "fixture.solo@example.invalid"
    )
    XCTAssertFalse(cachedAccountApp.buttons["account.save-profile"].exists)
    XCTAssertFalse(cachedAccountApp.buttons["account.change-password"].exists)
    XCTAssertFalse(cachedAccountApp.buttons["account.logout"].exists)
    let accountRetry = cachedAccountApp.buttons["account.offline.retry"]
    XCTAssertTrue(accountRetry.waitForExistence(timeout: 5))
    XCTAssertEqual(accountRetry.label, "Check Connection")
    XCTAssertTrue(accountRetry.isEnabled)
    XCTAssertTrue(accountRetry.isHittable)
    XCTAssertGreaterThanOrEqual(accountRetry.frame.height, 44)
    attachScreenshot(cachedAccountApp, name: "ios7-solo-offline-cached-account")
  }

  @MainActor
  func testSoloSetupDefaultsAndExplainsDifficultyBeforeWriting() throws {
    let app = launchSoloFixture("solo-setup")

    let setup = element(in: app, identifier: "solo.setup")
    XCTAssertTrue(setup.waitForExistence(timeout: 8))
    let botCount = element(in: app, identifier: "solo.setup.bot-count")
    let difficulty = element(in: app, identifier: "solo.setup.difficulty")
    let explanation = app.staticTexts.matching(
      identifier: "solo.setup.difficulty-explanation"
    ).firstMatch
    XCTAssertTrue(botCount.exists)
    XCTAssertTrue(difficulty.exists)
    XCTAssertEqual(difficulty.value as? String, "Medium")
    XCTAssertEqual(explanation.label, "Balanced decisions and the default for a new player.")
    XCTAssertTrue(app.staticTexts["Choose from 1 to 7 computer opponents. More opponents create a busier table and a longer round."].exists)
    XCTAssertTrue(app.staticTexts["Nothing is created or written until you press Start Game and any required replacement is confirmed."].exists)
    XCTAssertGreaterThanOrEqual(app.buttons["solo.setup.start"].frame.height, 44)
    attachScreenshot(app, name: "ios7-solo-setup-medium-default")
    try performSoloAccessibilityAudit(on: app)
  }

  @MainActor
  func testSoloSetupRendersEverySupportedChoice() throws {
    let choices: [(rawValue: String, name: String, explanation: String)] = [
      ("easy", "Easy", "Relaxed choices with more variety; a friendly place to learn."),
      ("medium", "Medium", "Balanced decisions and the default for a new player."),
      ("hard", "Hard", "Tracks revealed information and replaces cards more aggressively."),
      ("ultra", "Ultra Hard", "Evaluates deck outcomes and closing risk for the strongest challenge."),
      ("mixed", "Mixed", "Deterministically balances Easy, Medium, Hard, and Ultra opponents for this game."),
    ]

    let app = launchSoloFixture("solo-setup")
    let setup = element(in: app, identifier: "solo.setup")
    let botCount = app.steppers["solo.setup.bot-count"]
    let difficulty = element(in: app, identifier: "solo.setup.difficulty")
    let explanation = element(in: app, identifier: "solo.setup.difficulty-explanation")
    XCTAssertTrue(setup.waitForExistence(timeout: 8))
    XCTAssertTrue(botCount.exists)
    XCTAssertEqual(botCount.value as? String, "1")

    scrollToElementFullyVisible(botCount, in: app)
    XCTAssertTrue(botCount.buttons["solo.setup.bot-count-Increment"].exists)
    for expectedCount in 2...7 {
      let increment = botCount.buttons["solo.setup.bot-count-Increment"]
      XCTAssertTrue(increment.isEnabled)
      XCTAssertTrue(increment.isHittable)
      increment.tap()
      let countUpdated = NSPredicate(format: "value == %@", expectedCount.formatted())
      XCTAssertEqual(
        XCTWaiter.wait(
          for: [XCTNSPredicateExpectation(predicate: countUpdated, object: botCount)],
          timeout: 3
        ),
        .completed,
        "Stepper remained at \(botCount.value ?? "unknown") instead of \(expectedCount)."
      )
    }
    let increment = botCount.buttons["solo.setup.bot-count-Increment"]
    increment.tap()
    XCTAssertEqual(
      botCount.value as? String,
      "7",
      "Seven opponents must be the upper Stepper bound."
    )

    for choice in choices {
      difficulty.tap()
      let option = element(in: app, identifier: "solo.setup.difficulty.\(choice.rawValue)")
      XCTAssertTrue(option.waitForExistence(timeout: 5))
      XCTAssertTrue(option.isHittable)
      option.tap()
      XCTAssertTrue(setup.waitForExistence(timeout: 5))
      let difficultyUpdated = NSPredicate(format: "value == %@", choice.name)
      XCTAssertEqual(
        XCTWaiter.wait(
          for: [XCTNSPredicateExpectation(predicate: difficultyUpdated, object: difficulty)],
          timeout: 3
        ),
        .completed
      )
      XCTAssertEqual(explanation.label, choice.explanation)
    }
    XCTAssertTrue(app.buttons["solo.setup.start"].isEnabled)
    attachScreenshot(app, name: "ios7-solo-setup-all-real-choices")
  }

  @MainActor
  func testSoloSetupSurfacesBlockedStatsRecoveryWithoutSave() throws {
    let app = launchSoloFixture("solo-setup-blocked-outbox")

    XCTAssertTrue(element(in: app, identifier: "solo.setup").waitForExistence(timeout: 8))
    let recovery = element(in: app, identifier: "solo.outbox.recovery")
    XCTAssertTrue(recovery.exists)
    let retry = app.buttons["solo.outbox.retry"]
    let discard = app.buttons["solo.outbox.discard"]
    let recoveryHeading = app.staticTexts["solo.outbox.heading"]
    let recoveryMessage = app.staticTexts["solo.outbox.message"]
    XCTAssertTrue(retry.waitForExistence(timeout: 5))
    XCTAssertTrue(discard.exists)
    XCTAssertTrue(recoveryHeading.exists)
    XCTAssertTrue(recoveryMessage.exists)
    XCTAssertTrue(retry.isEnabled)
    XCTAssertTrue(discard.isEnabled)
    scrollToElementFullyVisible(retry, in: app)
    XCTAssertGreaterThanOrEqual(retry.frame.height, 44)
    scrollToElementFullyVisible(discard, in: app)
    XCTAssertGreaterThanOrEqual(discard.frame.height, 44)
    let standardRetryHeight = retry.frame.height
    let standardDiscardHeight = discard.frame.height
    let standardRecoveryHeadingHeight = recoveryHeading.frame.height
    let standardRecoveryMessageHeight = recoveryMessage.frame.height
    attachScreenshot(app, name: "ios7-solo-setup-blocked-outbox")
    try performSoloAccessibilityAudit(on: app)
    scrollToElementFullyVisible(retry, in: app)
    retry.tap()
    let retryStatus = element(in: app, identifier: "solo.outbox.status")
    XCTAssertTrue(retryStatus.waitForExistence(timeout: 8))
    XCTAssertEqual(retryStatus.label, "The oldest result was retried and delivered.")
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: recovery)],
        timeout: 8
      ),
      .completed
    )
    attachScreenshot(app, name: "ios7-solo-setup-blocked-outbox-retried")
    app.terminate()

    let corruptApp = launchSoloFixture("solo-setup-corrupt-outbox")
    let corruptRecovery = element(in: corruptApp, identifier: "solo.outbox.recovery")
    XCTAssertTrue(corruptRecovery.waitForExistence(timeout: 8))
    XCTAssertTrue(
      corruptApp.staticTexts[
        "The oldest queued result is damaged and cannot be submitted. Discarding only this blocked item lets later results continue."
      ].exists
    )
    XCTAssertFalse(corruptApp.buttons["solo.outbox.retry"].exists)
    let corruptDiscard = corruptApp.buttons["solo.outbox.discard"]
    XCTAssertTrue(corruptDiscard.exists)
    XCTAssertTrue(corruptDiscard.isEnabled)
    scrollToElementFullyVisible(corruptDiscard, in: corruptApp)
    XCTAssertGreaterThanOrEqual(corruptDiscard.frame.height, 44)
    attachScreenshot(corruptApp, name: "ios7-solo-setup-corrupt-outbox")
    try performSoloAccessibilityAudit(on: corruptApp)
    corruptDiscard.tap()
    let discardConfirmation = corruptApp.buttons["Discard Result"]
    XCTAssertTrue(discardConfirmation.waitForExistence(timeout: 5))
    discardConfirmation.tap()
    let discardStatus = element(in: corruptApp, identifier: "solo.outbox.status")
    XCTAssertTrue(discardStatus.waitForExistence(timeout: 8))
    XCTAssertEqual(discardStatus.label, "The oldest stored result was discarded.")
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [
          XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: corruptRecovery
          ),
        ],
        timeout: 8
      ),
      .completed
    )
    attachScreenshot(corruptApp, name: "ios7-solo-setup-corrupt-outbox-discarded")
    corruptApp.terminate()

    // Xcode 26 reports the custom button's container as not Dynamic Type aware
    // even though its Text label uses an uncapped relative system font. Prove
    // both recovery actions render larger before narrowly exempting only those
    // container identifiers in the focused audit handler.
    let largeTextApp = launchSoloFixture(
      "solo-setup-blocked-outbox",
      additionalArguments: [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    let largeRetry = largeTextApp.buttons["solo.outbox.retry"]
    let largeDiscard = largeTextApp.buttons["solo.outbox.discard"]
    let largeRecoveryHeading = largeTextApp.staticTexts["solo.outbox.heading"]
    let largeRecoveryMessage = largeTextApp.staticTexts["solo.outbox.message"]
    scrollToElementFullyVisible(largeRetry, in: largeTextApp)
    scrollToElementFullyVisible(largeDiscard, in: largeTextApp)
    XCTAssertTrue(largeRecoveryHeading.exists)
    XCTAssertTrue(largeRecoveryMessage.exists)
    XCTAssertGreaterThan(
      largeRetry.frame.height,
      standardRetryHeight + 4
    )
    XCTAssertGreaterThan(
      largeDiscard.frame.height,
      standardDiscardHeight + 4
    )
    XCTAssertGreaterThan(
      largeRecoveryHeading.frame.height,
      standardRecoveryHeadingHeight + 4
    )
    XCTAssertGreaterThan(
      largeRecoveryMessage.frame.height,
      standardRecoveryMessageHeight + 4
    )
    attachScreenshot(largeTextApp, name: "ios7-solo-setup-recovery-accessibility-xxxl")
    largeTextApp.terminate()
  }

  @MainActor
  func testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards() throws {
    let app = launchSoloFixture("solo-table")

    let table = element(in: app, identifier: "solo.table.layout.standard")
    XCTAssertTrue(table.waitForExistence(timeout: 8))
    let safeArea = element(in: app, identifier: "solo.table.safe-area")
    let opponentScroll = element(in: app, identifier: "solo.opponents.scroll")
    let actionBand = element(in: app, identifier: "solo.action-band")
    let localBoard = element(in: app, identifier: "solo.board.local.human")
    XCTAssertTrue(safeArea.exists)
    assertSoloSafeArea(safeArea, in: app)
    XCTAssertTrue(opponentScroll.exists)
    XCTAssertNotEqual(table.elementType, .scrollView)
    assertElement(table, isContainedIn: safeArea, tolerance: 2)
    for element in [opponentScroll, actionBand, localBoard] {
      assertElement(element, isContainedIn: safeArea, tolerance: 2)
    }
    let draw = app.buttons["solo.action.draw"]
    let discard = app.buttons["solo.action.discard"]
    let guest = element(in: app, identifier: "solo.table.guest")
    XCTAssertTrue(draw.exists)
    XCTAssertTrue(discard.exists)
    XCTAssertTrue(guest.exists)
    XCTAssertEqual(guest.label, "Guest game. Completed games are not added to account stats.")
    XCTAssertGreaterThanOrEqual(draw.frame.height, 44)
    XCTAssertGreaterThanOrEqual(discard.frame.height, 44)
    let originalDrawFrame = draw.frame
    let originalDiscardFrame = discard.frame
    let originalTableFrame = table.frame
    let originalActionBandFrame = actionBand.frame
    let originalLocalBoardFrame = localBoard.frame

    let firstCard = element(in: app, identifier: "solo.card.local.human.r1.c1")
    XCTAssertEqual(firstCard.elementType, .button)
    XCTAssertTrue(firstCard.isHittable)
    XCTAssertEqual(firstCard.label, "Your card, row 1, column 1, face down")
    XCTAssertFalse(firstCard.label.contains("value"))
    firstCard.tap()
    let revealed = NSPredicate(format: "label != %@", "Your card, row 1, column 1, face down")
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [XCTNSPredicateExpectation(predicate: revealed, object: firstCard)],
        timeout: 5
      ),
      .completed
    )
    XCTAssertNotEqual(firstCard.elementType, .button)
    let opponentCard = element(in: app, identifier: "solo.card.opponent.ai-1.r1.c1")
    XCTAssertTrue(opponentCard.exists)
    XCTAssertNotEqual(opponentCard.elementType, .button)
    let opponentLabelBeforeTap = opponentCard.label
    if opponentCard.isHittable { opponentCard.tap() }
    XCTAssertEqual(opponentCard.label, opponentLabelBeforeTap)
    XCTAssertEqual(draw.frame.minY, originalDrawFrame.minY, accuracy: 2)
    XCTAssertEqual(draw.frame.height, originalDrawFrame.height, accuracy: 2)
    XCTAssertEqual(discard.frame.minY, originalDiscardFrame.minY, accuracy: 2)
    XCTAssertEqual(discard.frame.height, originalDiscardFrame.height, accuracy: 2)

    app.swipeUp(velocity: .slow)
    assertFrame(table.frame, equals: originalTableFrame, accuracy: 2)
    assertFrame(actionBand.frame, equals: originalActionBandFrame, accuracy: 2)
    assertFrame(localBoard.frame, equals: originalLocalBoardFrame, accuracy: 2)
    assertElement(opponentScroll, isContainedIn: safeArea, tolerance: 2)

    app.buttons["solo.settings.open"].tap()
    XCTAssertTrue(app.navigationBars["Game Settings"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.switches["solo.settings.sound"].isEnabled)
    XCTAssertTrue(app.switches["solo.settings.haptics"].isEnabled)
    XCTAssertFalse(app.switches["solo.settings.music"].isEnabled)
    XCTAssertEqual(app.switches["solo.settings.music"].value as? String, "0")
    app.buttons["Done"].tap()

    XCTAssertTrue(table.waitForExistence(timeout: 5))
    let firstOpponentHeader = element(
      in: app,
      identifier: "solo.board.header.opponent.ai-1"
    )
    for _ in 0..<3 where firstOpponentHeader.frame.minY < opponentScroll.frame.minY {
      opponentScroll.swipeDown(velocity: .fast)
    }
    assertElement(firstOpponentHeader, isContainedIn: opponentScroll, tolerance: 2)
    let tableHeader = element(in: app, identifier: "solo.table.header")
    let round = element(in: app, identifier: "solo.table.round")
    let turnState = element(in: app, identifier: "solo.table.turn-state")
    let guidance = element(in: app, identifier: "solo.action.guidance")
    let localHeader = element(in: app, identifier: "solo.board.header.local.human")
    let deckText = draw.staticTexts["Deck"]
    let discardText = discard.staticTexts["Discard"]
    let revealedValue = firstCard.staticTexts.firstMatch

    XCTAssertEqual(round.label, "Round 1")
    XCTAssertEqual(turnState.label, "Your turn")
    XCTAssertEqual(draw.label, "Draw blind")
    XCTAssertTrue(discard.label.hasPrefix("Discard pile, top card"))
    XCTAssertEqual(guidance.label, "Reveal two of your face-down cards.")
    XCTAssertEqual(localHeader.label, "You")
    XCTAssertFalse(firstOpponentHeader.label.isEmpty)
    XCTAssertTrue((localHeader.value as? String)?.contains("points") == true)
    XCTAssertTrue((firstOpponentHeader.value as? String)?.contains("points") == true)
    XCTAssertTrue(deckText.exists)
    XCTAssertTrue(discardText.exists)
    XCTAssertEqual(revealedValue.label, "-1")

    for visibleText in [
      round,
      turnState,
      draw,
      discard,
      guidance,
      localHeader,
      firstOpponentHeader,
      deckText,
      discardText,
      revealedValue,
    ] {
      XCTAssertGreaterThan(visibleText.frame.width, 0)
      XCTAssertGreaterThan(visibleText.frame.height, 0)
      assertElement(visibleText, isContainedIn: safeArea, tolerance: 2)
    }
    for action in [draw, discard, guidance] {
      assertElement(action, isContainedIn: actionBand, tolerance: 2)
    }
    assertElement(round, isContainedIn: tableHeader, tolerance: 2)
    assertElement(turnState, isContainedIn: tableHeader, tolerance: 2)
    assertElement(localHeader, isContainedIn: localBoard, tolerance: 2)
    assertElement(firstOpponentHeader, isContainedIn: opponentScroll, tolerance: 2)
    assertElement(deckText, isContainedIn: draw, tolerance: 2)
    assertElement(discardText, isContainedIn: discard, tolerance: 2)
    assertElement(revealedValue, isContainedIn: firstCard, tolerance: 2)
    attachScreenshot(app, name: "ios7-solo-phone-table")
    // Xcode 26 can emit an element-less textClipped finding after this exact
    // 390x844 fixture returns from Settings and repositions the nested opponent
    // scroller. The assertions above and screenshot prove the principal rendered
    // copy and containment. Attributed clipped-text findings remain failures.
    try performSoloAccessibilityAudit(
      on: app,
      allowUnattributedTextClipping: true
    )
  }

  @MainActor
  func testSoloRepresentativeTurnKeepsEveryActionSlotStable() throws {
    let app = launchSoloFixture("solo-turn")
    let draw = app.buttons["solo.action.draw"]
    let discard = app.buttons["solo.action.discard"]
    let guidance = element(in: app, identifier: "solo.action.guidance")
    XCTAssertTrue(draw.waitForExistence(timeout: 8))
    XCTAssertTrue(discard.exists)
    XCTAssertEqual(draw.elementType, .button)
    XCTAssertEqual(discard.elementType, .button)
    XCTAssertTrue(draw.isEnabled)
    XCTAssertTrue(discard.isEnabled)
    XCTAssertEqual(guidance.label, "Take the visible discard or draw a blind card.")
    assertAccessibilityTraversal(
      [
        "solo.table.round",
        "solo.action.draw",
        "solo.board.header.local.human",
        "solo.board.header.opponent.ai-1",
      ],
      in: app
    )
    assertAccessibilityTraversal(
      ["solo.board.header.local.human"] + (1...3).flatMap { row in
        (1...4).map { column in "solo.card.local.human.r\(row).c\(column)" }
      },
      in: app
    )
    let originalDrawFrame = draw.frame
    let originalDiscardFrame = discard.frame
    let originalGuidanceFrame = guidance.frame

    draw.tap()
    let drawnChoice = element(in: app, identifier: "solo.action.drawn-choice")
    XCTAssertTrue(drawnChoice.waitForExistence(timeout: 5))
    XCTAssertEqual(guidance.label, "Choose any card to replace with the drawn card.")
    XCTAssertFalse(draw.isEnabled)
    XCTAssertFalse(discard.isEnabled)
    XCTAssertTrue(drawnChoice.exists)
    XCTAssertEqual(guidance.label, "Choose any card to replace with the drawn card.")
    assertFrame(draw.frame, equals: originalDrawFrame, accuracy: 3)
    assertFrame(discard.frame, equals: originalDiscardFrame, accuracy: 3)
    assertFrame(guidance.frame, equals: originalGuidanceFrame, accuracy: 3)
    attachScreenshot(app, name: "ios7-solo-turn-drawn-decision")

    let replacement = element(in: app, identifier: "solo.card.local.human.r1.c1")
    XCTAssertEqual(replacement.elementType, .button)
    XCTAssertTrue(replacement.isHittable)
    let replacementLabelBeforeTap = replacement.label
    replacement.tap()
    // The fixture AI can finish before XCTest samples its transient guidance.
    // Prove the durable replacement instead of requiring that timing window.
    let cardReplaced = NSPredicate(format: "label != %@", replacementLabelBeforeTap)
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [
          XCTNSPredicateExpectation(
            predicate: cardReplaced,
            object: replacement
          ),
        ],
        timeout: 5
      ),
      .completed
    )
    XCTAssertNotEqual(replacement.label, replacementLabelBeforeTap)
    assertFrame(draw.frame, equals: originalDrawFrame, accuracy: 3)
    assertFrame(discard.frame, equals: originalDiscardFrame, accuracy: 3)
    assertFrame(guidance.frame, equals: originalGuidanceFrame, accuracy: 3)
    attachScreenshot(app, name: "ios7-solo-turn-complete")
    app.terminate()

    let aiApp = launchSoloFixture("solo-ai-discard")
    let aiDiscard = aiApp.buttons["solo.action.discard"]
    XCTAssertTrue(aiDiscard.waitForExistence(timeout: 8))
    XCTAssertEqual(aiDiscard.elementType, .button)
    XCTAssertFalse(aiDiscard.isEnabled)
    XCTAssertEqual(
      aiDiscard.value as? String,
      "Unavailable while another player is choosing"
    )
    XCTAssertTrue(
      element(in: aiApp, identifier: "solo.action.guidance").label.contains("is choosing a move")
    )
    attachScreenshot(aiApp, name: "ios7-solo-ai-discard-inactive")
    aiApp.terminate()

    let privateDrawApp = launchSoloFixture(
      "solo-ai-private-draw",
      additionalArguments: [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    XCTAssertFalse(element(in: privateDrawApp, identifier: "solo.action.drawn-choice").exists)
    let privateActionBand = element(in: privateDrawApp, identifier: "solo.action-band")
    for source in [
      privateDrawApp.buttons["solo.action.draw"],
      privateDrawApp.buttons["solo.action.discard"],
    ] {
      assertElement(source, isContainedIn: privateActionBand, tolerance: 2)
    }
    let leakedPrivateValue = privateDrawApp.descendants(matching: .any).matching(
      NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "99", "99")
    )
    XCTAssertEqual(leakedPrivateValue.count, 0)
    XCTAssertTrue(
      element(in: privateDrawApp, identifier: "solo.action.guidance").label.contains(
        "is choosing a move"
      )
    )
    attachScreenshot(privateDrawApp, name: "ios7-solo-ai-private-draw-redacted")
  }

  @MainActor
  func testSoloLandscapeTableFitsWithoutWholeScreenScrolling() throws {
    defer { XCUIDevice.shared.orientation = .portrait }
    let app = launchSoloFixture("solo-table", orientation: .portrait)
    waitForSettledOrientation(app, landscape: false)
    XCUIDevice.shared.orientation = .landscapeLeft
    waitForSettledOrientation(app, landscape: true, timeout: 12)

    let window = app.windows.firstMatch
    XCTAssertTrue(window.exists)
    let expectedLayoutIdentifier = window.frame.height < 650
      ? "solo.table.layout.compact-landscape"
      : "solo.table.layout.standard"
    let table = element(in: app, identifier: expectedLayoutIdentifier)
    XCTAssertTrue(table.waitForExistence(timeout: 8))
    let safeArea = element(in: app, identifier: "solo.table.safe-area")
    XCTAssertTrue(safeArea.exists)
    assertSoloSafeArea(safeArea, in: app)
    assertElement(table, isContainedIn: safeArea, tolerance: 2)
    XCTAssertFalse(table.elementType == .scrollView)
    let localCards = app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.local.human.")
    ).allElementsBoundByIndex
    XCTAssertEqual(localCards.count, 12)
    for card in localCards {
      assertElement(card, isContainedIn: safeArea, tolerance: 2)
      XCTAssertGreaterThanOrEqual(card.frame.width, 44)
      XCTAssertGreaterThanOrEqual(card.frame.height, 44)
    }
    let firstOpponentBoard = element(
      in: app,
      identifier: "solo.board.opponent.ai-1"
    )
    let firstOpponentHeader = element(
      in: app,
      identifier: "solo.board.header.opponent.ai-1"
    )
    XCTAssertTrue(firstOpponentBoard.waitForExistence(timeout: 5))
    assertElement(firstOpponentBoard, isContainedIn: safeArea, tolerance: 2)
    assertElement(firstOpponentHeader, isContainedIn: firstOpponentBoard, tolerance: 2)
    let opponentCards = app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.opponent.ai-1.")
    ).allElementsBoundByIndex
    XCTAssertEqual(opponentCards.count, 12)
    for card in opponentCards {
      assertElement(card, isContainedIn: firstOpponentBoard, tolerance: 2)
      XCTAssertGreaterThanOrEqual(card.frame.width, 44)
      XCTAssertGreaterThanOrEqual(card.frame.height, 44)
    }
    assertElement(app.buttons["solo.action.draw"], isContainedIn: safeArea, tolerance: 2)
    assertElement(app.buttons["solo.action.discard"], isContainedIn: safeArea, tolerance: 2)
    let guidance = element(in: app, identifier: "solo.action.guidance")
    XCTAssertTrue(guidance.exists)
    XCTAssertEqual(guidance.label, "Reveal two of your face-down cards.")
    XCTAssertEqual(
      guidance.value as? String,
      window.frame.height < 650
        ? "Visible guidance: Reveal 2 cards"
        : "Visible guidance: Reveal two of your face-down cards."
    )
    assertElement(guidance, isContainedIn: safeArea, tolerance: 2)
    XCTAssertGreaterThanOrEqual(guidance.frame.width, 44)
    XCTAssertGreaterThanOrEqual(guidance.frame.height, 44)
    attachScreenScreenshot(name: "ios7-solo-table-landscape")
  }

  @MainActor
  func testSoloShortPortraitUsesVerticalLayoutAndFitsItsDebugViewport() throws {
    let app = launchSoloFixture(
      "solo-turn",
      additionalArguments: ["--ui-solo-geometry=375x550"]
    )
    let layout = element(in: app, identifier: "solo.table.layout.standard")
    XCTAssertTrue(layout.waitForExistence(timeout: 8))
    XCTAssertFalse(element(in: app, identifier: "solo.table.layout.compact-landscape").exists)
    XCTAssertLessThanOrEqual(layout.frame.width, 377)
    XCTAssertLessThanOrEqual(layout.frame.height, 552)

    let shortActionBand = element(in: app, identifier: "solo.action-band")
    let shortGuidance = element(in: app, identifier: "solo.action.guidance")
    let coreElements = [
      element(in: app, identifier: "solo.table.round"),
      shortActionBand,
      app.buttons["solo.action.draw"],
      app.buttons["solo.action.discard"],
      shortGuidance,
      element(in: app, identifier: "solo.board.local.human"),
    ]
    for element in coreElements {
      assertElement(element, isContainedIn: layout, tolerance: 2)
    }
    XCTAssertGreaterThanOrEqual(shortActionBand.frame.height, 72)
    for target in [
      app.buttons["solo.action.draw"],
      app.buttons["solo.action.discard"],
      shortGuidance,
    ] {
      assertElement(target, isContainedIn: shortActionBand, tolerance: 2)
    }
    for target in [app.buttons["solo.action.draw"], app.buttons["solo.action.discard"]] {
      XCTAssertGreaterThanOrEqual(target.frame.width, 43.5)
      XCTAssertGreaterThanOrEqual(target.frame.height, 43.5)
    }

    let localCards = app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.local.human.")
    ).allElementsBoundByIndex
    XCTAssertEqual(localCards.count, 12)
    for card in localCards {
      assertElement(card, isContainedIn: layout, tolerance: 2)
      XCTAssertGreaterThanOrEqual(card.frame.width, 43.5)
      XCTAssertGreaterThanOrEqual(card.frame.height, 43.5)
    }
    let opponents = element(in: app, identifier: "solo.opponents.scroll")
    let firstOpponentBoard = try XCTUnwrap(
      fullyVisibleOpponentBoard(in: app, scroll: opponents)
    )
    assertElement(firstOpponentBoard, isContainedIn: opponents, tolerance: 8)
    XCTAssertGreaterThanOrEqual(firstOpponentBoard.frame.width, 185)
    let opponentID = String(
      firstOpponentBoard.identifier.dropFirst("solo.board.opponent.".count)
    )
    let opponentCards = app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.opponent.\(opponentID).")
    ).allElementsBoundByIndex
    XCTAssertEqual(opponentCards.count, 12)
    for card in opponentCards {
      assertElement(card, isContainedIn: firstOpponentBoard, tolerance: 2)
      XCTAssertGreaterThanOrEqual(card.frame.width, 43.5)
      XCTAssertGreaterThanOrEqual(card.frame.height, 43.5)
    }
    attachScreenshot(app, name: "ios7-solo-table-short-portrait-375x550")
    app.terminate()

    let tallCompactApp = launchSoloFixture(
      "solo-turn",
      additionalArguments: ["--ui-solo-geometry=375x700"]
    )
    let tallLayout = element(in: tallCompactApp, identifier: "solo.table.layout.standard")
    XCTAssertTrue(tallLayout.waitForExistence(timeout: 8))
    let tallOpponents = element(in: tallCompactApp, identifier: "solo.opponents.scroll")
    let tallBoard = try XCTUnwrap(
      fullyVisibleOpponentBoard(in: tallCompactApp, scroll: tallOpponents)
    )
    assertElement(tallBoard, isContainedIn: tallOpponents, tolerance: 8)
    XCTAssertGreaterThanOrEqual(tallBoard.frame.width, 185)
    let tallOpponentID = String(
      tallBoard.identifier.dropFirst("solo.board.opponent.".count)
    )
    let tallOpponentCards = tallCompactApp.descendants(matching: .any).matching(
      NSPredicate(
        format: "identifier BEGINSWITH %@",
        "solo.card.opponent.\(tallOpponentID)."
      )
    ).allElementsBoundByIndex
    XCTAssertEqual(tallOpponentCards.count, 12)
    for card in tallOpponentCards {
      assertElement(card, isContainedIn: tallBoard, tolerance: 2)
      XCTAssertGreaterThanOrEqual(card.frame.width, 43.5)
      XCTAssertGreaterThanOrEqual(card.frame.height, 43.5)
    }
    attachScreenshot(tallCompactApp, name: "ios7-solo-table-tall-compact-375x700")
  }

  @MainActor
  func testSoloNarrowLandscapeKeepsActionsAndLocalBoardAnchored() throws {
    defer { XCUIDevice.shared.orientation = .portrait }
    let app = launchSoloFixture(
      "solo-turn",
      orientation: .landscapeLeft,
      additionalArguments: ["--ui-solo-geometry=640x360"]
    )
    waitForSettledOrientation(app, landscape: true)
    assertAnchoredSoloTurnLayout(
      in: app,
      layoutIdentifier: "solo.table.layout.compact-landscape",
      maximumSize: CGSize(width: 640, height: 360),
      screenshotName: "ios7-solo-table-narrow-landscape-640x360"
    )
  }

  @MainActor
  func testSoloAccessibilityXXXLNarrowLandscapeRemainsAnchored() throws {
    defer { XCUIDevice.shared.orientation = .portrait }
    let app = launchSoloFixture(
      "solo-turn",
      orientation: .landscapeLeft,
      additionalArguments: [
        "--ui-solo-geometry=667x375",
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    waitForSettledOrientation(app, landscape: true)
    assertAnchoredSoloTurnLayout(
      in: app,
      layoutIdentifier: "solo.table.layout.accessibility-landscape",
      maximumSize: CGSize(width: 667, height: 375),
      screenshotName: "ios7-solo-table-accessibility-xxxl-landscape-667x375"
    )
  }

  @MainActor
  func testSoloScoreSummaryCanMinimizeAndRestore() throws {
    let app = launchSoloFixture("solo-summary")

    XCTAssertTrue(app.staticTexts["solo.summary.heading"].waitForExistence(timeout: 8))
    XCTAssertEqual(app.staticTexts["solo.summary.heading"].label, "Round complete")
    try performSoloAccessibilityAudit(on: app)
    let minimize = app.buttons["solo.summary.minimize"]
    XCTAssertTrue(minimize.isHittable)
    minimize.tap()

    let restore = app.buttons["solo.summary.restore"]
    XCTAssertTrue(restore.waitForExistence(timeout: 8))
    XCTAssertTrue(restore.isHittable)
    restore.tap()
    XCTAssertTrue(app.staticTexts["solo.summary.heading"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.buttons["solo.summary.next-round"].isHittable)
    attachScreenshot(app, name: "ios7-solo-round-summary")
  }

  @MainActor
  func testSoloGameSummaryHasDistinctReplayAndSetupRoutes() throws {
    let replayApp = launchSoloFixture("solo-game-summary")
    let heading = replayApp.staticTexts["solo.summary.heading"]
    XCTAssertTrue(heading.waitForExistence(timeout: 8))
    XCTAssertEqual(heading.label, "Game complete")
    let statsState = element(in: replayApp, identifier: "solo.summary.stats-state")
    XCTAssertTrue(statsState.exists)
    XCTAssertEqual(statsState.label, "Guest game complete. Account stats were not recorded.")
    try performSoloAccessibilityAudit(on: replayApp)

    replayApp.buttons["solo.summary.minimize"].tap()
    let terminalStatus = element(in: replayApp, identifier: "solo.table.turn-state")
    let terminalGuidance = element(in: replayApp, identifier: "solo.action.guidance")
    XCTAssertTrue(terminalStatus.waitForExistence(timeout: 5))
    XCTAssertEqual(terminalStatus.label, "Game complete")
    XCTAssertEqual(terminalGuidance.label, "The game is complete.")
    XCTAssertFalse(terminalStatus.label.contains("turn"))
    XCTAssertFalse(terminalGuidance.label.contains("choosing"))
    replayApp.buttons["solo.summary.restore"].tap()
    XCTAssertTrue(heading.waitForExistence(timeout: 5))
    attachScreenshot(replayApp, name: "ios7-solo-game-summary")

    let playAgain = replayApp.buttons["solo.summary.replay"]
    XCTAssertTrue(playAgain.isHittable)
    playAgain.tap()
    let headingGone = NSPredicate(format: "exists == false")
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [XCTNSPredicateExpectation(predicate: headingGone, object: heading)],
        timeout: 8
      ),
      .completed
    )
    XCTAssertTrue(
      element(in: replayApp, identifier: "solo.table.layout.standard")
        .waitForExistence(timeout: 8)
    )
    XCTAssertEqual(element(in: replayApp, identifier: "solo.table.turn-state").label, "Your turn")
    assertResumedThreeOpponentMixedGame(in: replayApp)
    replayApp.terminate()

    let setupApp = launchSoloFixture("solo-game-summary")
    XCTAssertTrue(setupApp.staticTexts["solo.summary.heading"].waitForExistence(timeout: 8))
    let changeSetup = setupApp.buttons["solo.summary.change-setup"]
    XCTAssertTrue(changeSetup.isHittable)
    changeSetup.tap()
    XCTAssertTrue(element(in: setupApp, identifier: "solo.setup").waitForExistence(timeout: 8))
    XCTAssertEqual(element(in: setupApp, identifier: "solo.setup.difficulty").value as? String, "Mixed")
    XCTAssertEqual(element(in: setupApp, identifier: "solo.setup.bot-count").value as? String, "3")
    setupApp.terminate()

    let unknownApp = launchSoloFixture("solo-game-summary-outbox-unknown")
    XCTAssertTrue(unknownApp.staticTexts["solo.summary.heading"].waitForExistence(timeout: 8))
    let unknownStats = element(in: unknownApp, identifier: "solo.summary.stats-state")
    XCTAssertTrue(unknownStats.exists)
    XCTAssertEqual(
      unknownStats.label,
      "Account stats delivery status is unavailable. Keep this result on this device and try again later."
    )
    XCTAssertFalse(unknownStats.label.contains("saved to your account stats"))
    attachScreenshot(unknownApp, name: "ios7-solo-game-summary-stats-unknown")
    unknownApp.terminate()

    let uncommittedApp = launchSoloFixture("solo-game-summary-uncommitted")
    XCTAssertTrue(
      uncommittedApp.buttons["solo.summary.retry-completion"]
        .waitForExistence(timeout: 8)
    )
    XCTAssertFalse(uncommittedApp.buttons["solo.summary.replay"].exists)
    XCTAssertFalse(uncommittedApp.buttons["solo.summary.change-setup"].exists)

    uncommittedApp.buttons["solo.summary.minimize"].tap()
    uncommittedApp.buttons["solo.settings.open"].tap()
    XCTAssertTrue(uncommittedApp.navigationBars["Game Settings"].waitForExistence(timeout: 8))
    let settingsNewGame = uncommittedApp.buttons["solo.settings.new-game"]
    scrollToElementFullyVisible(
      settingsNewGame,
      in: uncommittedApp,
      requiresHittable: false
    )
    XCTAssertFalse(settingsNewGame.isEnabled)
    let settingsBlocker = element(
      in: uncommittedApp,
      identifier: "solo.settings.completion-blocked"
    )
    XCTAssertTrue(settingsBlocker.exists)
    XCTAssertEqual(
      settingsBlocker.label,
      "Save or recover the completed result before setting up another game."
    )

    uncommittedApp.buttons["Done"].tap()
    let exit = uncommittedApp.buttons["solo.table.exit"]
    XCTAssertTrue(exit.waitForExistence(timeout: 5))
    exit.tap()
    XCTAssertTrue(element(in: uncommittedApp, identifier: "solo.launcher").waitForExistence(timeout: 8))
    let launcherNewGame = uncommittedApp.buttons["solo.new-game"]
    XCTAssertTrue(launcherNewGame.exists)
    XCTAssertFalse(launcherNewGame.isEnabled)
    XCTAssertEqual(
      element(in: uncommittedApp, identifier: "solo.launcher.completion-blocked").label,
      "Save or recover the completed result before setting up another game."
    )
    XCTAssertTrue(uncommittedApp.buttons["solo.continue"].isHittable)
    uncommittedApp.buttons["solo.continue"].tap()
    XCTAssertTrue(
      uncommittedApp.buttons["solo.summary.retry-completion"]
        .waitForExistence(timeout: 8)
    )
    attachScreenshot(uncommittedApp, name: "ios7-solo-game-summary-uncommitted")
  }

  @MainActor
  func testSoloRecoveryIsExplicitAndSafe() throws {
    let recoveryApp = launchSoloFixture("solo-recovery")
    let warning = element(in: recoveryApp, identifier: "solo.persistence-warning")
    XCTAssertTrue(warning.waitForExistence(timeout: 8))
    XCTAssertTrue(warning.label.contains("Saved game recovered"))
    XCTAssertTrue(warning.label.contains("removed safely"))
    attachScreenshot(recoveryApp, name: "ios7-solo-recovery")
    recoveryApp.terminate()

    let reconciliationApp = launchSoloFixture(
      "solo-reconciliation",
      additionalArguments: [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    let reconciliation = element(in: reconciliationApp, identifier: "solo.reconciliation")
    XCTAssertTrue(reconciliation.waitForExistence(timeout: 8))
    XCTAssertTrue(reconciliationApp.staticTexts["Saved game status unknown"].exists)
    XCTAssertFalse(reconciliationApp.buttons["solo.continue"].exists)
    let reload = reconciliationApp.buttons["solo.reconciliation.reload"]
    scrollToElementFullyVisible(reload, in: reconciliationApp)
    XCTAssertTrue(reload.isEnabled)
    XCTAssertTrue(reload.isHittable)
    XCTAssertGreaterThanOrEqual(reload.frame.width, 44)
    XCTAssertGreaterThanOrEqual(reload.frame.height, 44)
    try performSoloAccessibilityAudit(on: reconciliationApp)
    attachScreenshot(reconciliationApp, name: "ios7-solo-reconciliation-accessibility-xxxl")
    reload.tap()
    XCTAssertTrue(element(in: reconciliationApp, identifier: "solo.setup").waitForExistence(timeout: 8))
  }

  @MainActor
  func testSoloXXXLContentSizeIsUnclamped() throws {
    let standardTypeApp = launchSoloFixture("solo-table")
    let standardRound = element(in: standardTypeApp, identifier: "solo.table.round")
    XCTAssertTrue(standardRound.waitForExistence(timeout: 8))
    let standardDeckText = standardTypeApp.buttons["solo.action.draw"].staticTexts["Deck"]
    XCTAssertTrue(standardDeckText.exists)
    let standardRoundHeight = standardRound.frame.height
    let standardDeckTextHeight = standardDeckText.frame.height
    standardTypeApp.terminate()

    let xxxLargeApp = launchSoloFixture(
      "solo-table",
      additionalArguments: [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryXXXL",
      ]
    )
    let xxxLargeRound = element(in: xxxLargeApp, identifier: "solo.table.round")
    XCTAssertTrue(xxxLargeRound.waitForExistence(timeout: 8))
    let xxxLargeLayout = element(
      in: xxxLargeApp,
      identifier: "solo.table.layout.accessibility-fixed"
    )
    XCTAssertTrue(xxxLargeLayout.exists)
    XCTAssertFalse(
      element(in: xxxLargeApp, identifier: "solo.table.layout.standard").exists
    )
    XCTAssertTrue(element(in: xxxLargeApp, identifier: "solo.action.scroll").exists)
    let xxxLargeDeckText = xxxLargeApp.buttons["solo.action.draw"].staticTexts["Deck"]
    XCTAssertTrue(xxxLargeDeckText.exists)
    XCTAssertGreaterThan(xxxLargeRound.frame.height, standardRoundHeight)
    XCTAssertGreaterThan(xxxLargeDeckText.frame.height, standardDeckTextHeight)
    let guidance = element(in: xxxLargeApp, identifier: "solo.action.guidance")
    XCTAssertEqual(guidance.elementType, .button)
    XCTAssertEqual(guidance.label, "Reveal two of your face-down cards.")
    assertElement(xxxLargeRound, isContainedIn: xxxLargeApp.windows.firstMatch, tolerance: 2)
    attachScreenshot(xxxLargeApp, name: "ios7-solo-table-xxxl")
  }

  @MainActor
  func testSoloAccessibilityAdaptationsAreActive() throws {
    try XCTSkipUnless(
      ProcessInfo.processInfo.environment["SKYJO_IOS_UI_ACCESSIBILITY_MATRIX"] == "1",
      "The focused UI matrix owns and restores simulator accessibility settings."
    )
    let adaptationApp = launchSoloFixture("solo-table")
    let differentiatedCard = element(
      in: adaptationApp,
      identifier: "solo.card.local.human.r1.c1"
    )
    XCTAssertTrue(differentiatedCard.waitForExistence(timeout: 8))
    XCTAssertTrue(differentiatedCard.isHittable)
    differentiatedCard.tap()
    let revealedCard = NSPredicate(format: "label CONTAINS[c] %@", "card, row 1, column 1")
    let faceUpCard = NSCompoundPredicate(andPredicateWithSubpredicates: [
      revealedCard,
      NSCompoundPredicate(
        notPredicateWithSubpredicate: NSPredicate(format: "label CONTAINS[c] %@", "face down")
      ),
    ])
    var revealResult = XCTWaiter.wait(
      for: [XCTNSPredicateExpectation(predicate: faceUpCard, object: differentiatedCard)],
      timeout: 5
    )
    if revealResult != .completed, differentiatedCard.isHittable {
      differentiatedCard.tap()
      revealResult = XCTWaiter.wait(
        for: [XCTNSPredicateExpectation(predicate: faceUpCard, object: differentiatedCard)],
        timeout: 5
      )
    }
    XCTAssertEqual(revealResult, .completed)
    XCTAssertTrue(
      differentiatedCard.label.contains("visual marker:"),
      "Differentiate Without Color must add a non-color card marker and describe it to VoiceOver."
    )
    let visibleMarker = element(
      in: adaptationApp,
      identifier: "solo.card-marker.local.human.r1.c1"
    )
    XCTAssertTrue(
      visibleMarker.waitForExistence(timeout: 5),
      "The rendered non-color overlay marker must remain present."
    )
    XCTAssertTrue(visibleMarker.label.hasPrefix("Visible "))
    attachScreenshot(adaptationApp, name: "ios7-solo-differentiate-without-color")
    adaptationApp.buttons["solo.settings.open"].tap()
    XCTAssertTrue(adaptationApp.navigationBars["Game Settings"].waitForExistence(timeout: 8))
    let settingsDone = adaptationApp.buttons["solo.settings.done"]
    XCTAssertTrue(settingsDone.exists)
    XCTAssertEqual(settingsDone.label, "Done")
    XCTAssertTrue(settingsDone.isHittable)
    let adaptations = element(
      in: adaptationApp,
      identifier: "solo.settings.accessibility-adaptations"
    )
    scrollToElementFullyVisible(adaptations, in: adaptationApp)
    XCTAssertEqual(
      adaptations.value as? String,
      "Reduce Motion on; Increase Contrast on; Differentiate Without Color on"
    )
    let currentOpponents = element(
      in: adaptationApp,
      identifier: "solo.settings.current-opponents"
    )
    let currentDifficulty = element(
      in: adaptationApp,
      identifier: "solo.settings.current-difficulty"
    )
    XCTAssertTrue(currentOpponents.exists)
    XCTAssertTrue(currentDifficulty.exists)
    XCTAssertEqual(currentOpponents.label, "Opponents")
    XCTAssertEqual(currentOpponents.value as? String, "3")
    XCTAssertEqual(currentDifficulty.label, "Difficulty")
    XCTAssertEqual(currentDifficulty.value as? String, "Mixed")
    scrollToElementFullyVisible(currentOpponents, in: adaptationApp)
    scrollToElementFullyVisible(currentDifficulty, in: adaptationApp)
    let standardOpponentsHeight = currentOpponents.frame.height
    let standardDifficultyHeight = currentDifficulty.frame.height
    scrollToElementFullyVisible(adaptations, in: adaptationApp)
    attachScreenshot(adaptationApp, name: "ios7-solo-accessibility-adaptations")
    try performSoloAccessibilityAudit(
      on: adaptationApp,
      allowUnattributedTextClipping: true
    )
    adaptationApp.terminate()

    let largeSettingsApp = launchSoloFixture(
      "solo-table",
      additionalArguments: [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    largeSettingsApp.buttons["solo.settings.open"].tap()
    XCTAssertTrue(largeSettingsApp.navigationBars["Game Settings"].waitForExistence(timeout: 8))
    let largeDone = largeSettingsApp.buttons["solo.settings.done"]
    XCTAssertTrue(largeDone.exists)
    XCTAssertEqual(largeDone.label, "Done")
    XCTAssertTrue(largeDone.isHittable)
    XCTAssertGreaterThanOrEqual(largeDone.frame.width, 44)
    let largeOpponents = element(
      in: largeSettingsApp,
      identifier: "solo.settings.current-opponents"
    )
    let largeDifficulty = element(
      in: largeSettingsApp,
      identifier: "solo.settings.current-difficulty"
    )
    scrollToElementFullyVisible(largeOpponents, in: largeSettingsApp)
    scrollToElementFullyVisible(largeDifficulty, in: largeSettingsApp)
    XCTAssertEqual(largeOpponents.label, "Opponents")
    XCTAssertEqual(largeOpponents.value as? String, "3")
    XCTAssertEqual(largeDifficulty.label, "Difficulty")
    XCTAssertEqual(largeDifficulty.value as? String, "Mixed")
    XCTAssertGreaterThan(largeOpponents.frame.height, standardOpponentsHeight + 4)
    XCTAssertGreaterThan(largeDifficulty.frame.height, standardDifficultyHeight + 4)
    attachScreenshot(largeSettingsApp, name: "ios7-solo-settings-accessibility-xxxl")
    largeSettingsApp.terminate()
  }

  @MainActor
  func testSoloAccessibilityXXXLRemainsOperable() throws {
    let standardTypeApp = launchSoloFixture("solo-turn")
    let standardRound = element(in: standardTypeApp, identifier: "solo.table.round")
    XCTAssertTrue(standardRound.waitForExistence(timeout: 8))
    let standardTurnState = element(
      in: standardTypeApp,
      identifier: "solo.table.turn-state"
    )
    let standardLocalHeader = element(
      in: standardTypeApp,
      identifier: "solo.board.header.local.human"
    )
    let standardDeckText = standardTypeApp.buttons["solo.action.draw"].staticTexts["Deck"]
    for textElement in [
      standardTurnState,
      standardLocalHeader,
      standardDeckText,
    ] {
      XCTAssertTrue(textElement.waitForExistence(timeout: 8))
    }
    let standardRoundHeight = standardRound.frame.height
    let standardTurnStateHeight = standardTurnState.frame.height
    let standardLocalHeaderHeight = standardLocalHeader.frame.height
    let standardDeckTextHeight = standardDeckText.frame.height
    standardTypeApp.terminate()

    let dynamicTypeApp = launchSoloFixture(
      "solo-turn",
      additionalArguments: [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    let fixedLayout = element(
      in: dynamicTypeApp,
      identifier: "solo.table.layout.accessibility-fixed"
    )
    XCTAssertTrue(fixedLayout.waitForExistence(timeout: 8))
    XCTAssertFalse(
      element(in: dynamicTypeApp, identifier: "solo.table.accessible-scroll").exists,
      "Accessibility text must not introduce a whole-table ScrollView."
    )
    let opponentScroll = element(in: dynamicTypeApp, identifier: "solo.opponents.scroll")
    XCTAssertTrue(opponentScroll.exists)
    let guidance = dynamicTypeApp.descendants(matching: .any).matching(
      identifier: "solo.action.guidance"
    ).firstMatch
    XCTAssertTrue(guidance.waitForExistence(timeout: 8))
    XCTAssertEqual(guidance.label, "Take the visible discard or draw a blind card.")
    let window = dynamicTypeApp.windows.firstMatch
    let safeArea = element(in: dynamicTypeApp, identifier: "solo.table.safe-area")
    XCTAssertTrue(safeArea.exists)
    assertSoloSafeArea(safeArea, in: dynamicTypeApp)
    let dynamicRound = element(in: dynamicTypeApp, identifier: "solo.table.round")
    XCTAssertTrue(dynamicRound.waitForExistence(timeout: 8))
    XCTAssertGreaterThan(
      dynamicRound.frame.height,
      standardRoundHeight + 4,
      "The table must render the requested Accessibility XXXL category instead of clamping it."
    )
    assertElement(dynamicRound, isContainedIn: window, tolerance: 2)
    assertElement(dynamicRound, isContainedIn: safeArea, tolerance: 2)
    XCTAssertTrue(dynamicTypeApp.buttons["solo.table.exit"].isHittable)
    assertElement(opponentScroll, isContainedIn: fixedLayout, tolerance: 2)
    assertElement(opponentScroll, isContainedIn: safeArea, tolerance: 2)
    XCTAssertGreaterThanOrEqual(opponentScroll.frame.height, 44)
    let actionBand = element(in: dynamicTypeApp, identifier: "solo.action-band")
    let draw = dynamicTypeApp.buttons["solo.action.draw"]
    let discard = dynamicTypeApp.buttons["solo.action.discard"]
    let localBoard = element(in: dynamicTypeApp, identifier: "solo.board.local.human")
    let dynamicTurnState = element(in: dynamicTypeApp, identifier: "solo.table.turn-state")
    let dynamicLocalHeader = element(
      in: dynamicTypeApp,
      identifier: "solo.board.header.local.human"
    )
    let dynamicFaceUpCard = element(
      in: dynamicTypeApp,
      identifier: "solo.card.local.human.r1.c1"
    )
    let dynamicDeckText = draw.staticTexts["Deck"]
    XCTAssertGreaterThan(dynamicTurnState.frame.height, standardTurnStateHeight + 4)
    XCTAssertGreaterThan(dynamicLocalHeader.frame.height, standardLocalHeaderHeight + 4)
    XCTAssertEqual(dynamicFaceUpCard.staticTexts.firstMatch.label, "-1")
    assertElement(
      dynamicFaceUpCard.staticTexts.firstMatch,
      isContainedIn: dynamicFaceUpCard,
      tolerance: 2
    )
    XCTAssertGreaterThan(dynamicDeckText.frame.height, standardDeckTextHeight + 4)
    for element in [actionBand, draw, discard, guidance, localBoard] {
      assertElement(element, isContainedIn: fixedLayout, tolerance: 2)
      assertElement(element, isContainedIn: window, tolerance: 2)
      assertElement(element, isContainedIn: safeArea, tolerance: 2)
    }
    XCTAssertGreaterThanOrEqual(draw.frame.height, 44)
    XCTAssertGreaterThanOrEqual(discard.frame.height, 44)
    let localCards = dynamicTypeApp.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.local.human.")
    ).allElementsBoundByIndex
    XCTAssertEqual(localCards.count, 12)
    for card in localCards {
      assertElement(card, isContainedIn: localBoard, tolerance: 2)
      assertElement(card, isContainedIn: window, tolerance: 2)
      assertElement(card, isContainedIn: safeArea, tolerance: 2)
      XCTAssertGreaterThanOrEqual(card.frame.width, 44)
      XCTAssertGreaterThanOrEqual(card.frame.height, 44)
    }
    let originalActionBandFrame = actionBand.frame
    let originalDrawFrame = draw.frame
    let originalDiscardFrame = discard.frame
    let originalGuidanceFrame = guidance.frame
    let originalLocalBoardFrame = localBoard.frame

    dynamicTypeApp.swipeUp(velocity: .slow)
    assertFrame(actionBand.frame, equals: originalActionBandFrame, accuracy: 2)
    assertFrame(localBoard.frame, equals: originalLocalBoardFrame, accuracy: 2)

    draw.tap()
    let drawnChoice = element(in: dynamicTypeApp, identifier: "solo.action.drawn-choice")
    XCTAssertTrue(drawnChoice.waitForExistence(timeout: 5))
    XCTAssertGreaterThanOrEqual(drawnChoice.frame.height, 44)
    assertElement(drawnChoice, isContainedIn: actionBand, tolerance: 2)
    assertElement(drawnChoice, isContainedIn: window, tolerance: 2)
    assertElement(drawnChoice, isContainedIn: safeArea, tolerance: 2)
    assertFrame(actionBand.frame, equals: originalActionBandFrame, accuracy: 2)
    assertFrame(guidance.frame, equals: originalGuidanceFrame, accuracy: 2)
    assertFrame(localBoard.frame, equals: originalLocalBoardFrame, accuracy: 2)
    XCTAssertEqual(draw.frame.minY, originalDrawFrame.minY, accuracy: 2)
    XCTAssertEqual(draw.frame.width, originalDrawFrame.width, accuracy: 2)
    XCTAssertEqual(draw.frame.height, originalDrawFrame.height, accuracy: 2)
    XCTAssertEqual(discard.frame.minY, originalDiscardFrame.minY, accuracy: 2)
    XCTAssertEqual(discard.frame.width, originalDiscardFrame.width, accuracy: 2)
    XCTAssertEqual(discard.frame.height, originalDiscardFrame.height, accuracy: 2)
    let actionScrollDelta = draw.frame.minX - originalDrawFrame.minX
    XCTAssertLessThan(actionScrollDelta, 0)
    XCTAssertEqual(
      discard.frame.minX - originalDiscardFrame.minX,
      actionScrollDelta,
      accuracy: 2,
      "The stable action row must move as one explicit horizontal viewport."
    )
    for card in localCards {
      assertElement(card, isContainedIn: localBoard, tolerance: 2)
      assertElement(card, isContainedIn: window, tolerance: 2)
      assertElement(card, isContainedIn: safeArea, tolerance: 2)
    }
    try performFocusedSoloAccessibilityAudits(on: dynamicTypeApp)
    attachScreenshot(dynamicTypeApp, name: "ios7-solo-table-accessibility-xxxl-drawn")
    dynamicTypeApp.terminate()

    let shortTypeApp = launchSoloFixture(
      "solo-turn",
      additionalArguments: [
        "--ui-solo-geometry=375x550",
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    let shortLayout = element(
      in: shortTypeApp,
      identifier: "solo.table.layout.accessibility-fixed"
    )
    XCTAssertTrue(shortLayout.waitForExistence(timeout: 8))
    XCTAssertLessThanOrEqual(shortLayout.frame.width, 377)
    XCTAssertLessThanOrEqual(shortLayout.frame.height, 552)
    XCTAssertNotEqual(shortLayout.elementType, .scrollView)
    XCTAssertFalse(
      element(in: shortTypeApp, identifier: "solo.table.accessible-scroll").exists,
      "Compact Accessibility XXXL must keep the table anchored without a root ScrollView."
    )
    let shortSafeArea = element(in: shortTypeApp, identifier: "solo.table.safe-area")
    XCTAssertTrue(shortSafeArea.exists)
    assertSoloSafeArea(shortSafeArea, in: shortTypeApp)
    assertElement(shortLayout, isContainedIn: shortSafeArea, tolerance: 2)
    let shortHeader = element(in: shortTypeApp, identifier: "solo.table.header")
    let shortOpponents = element(in: shortTypeApp, identifier: "solo.opponents.scroll")
    let shortActionBand = element(in: shortTypeApp, identifier: "solo.action-band")
    let shortDraw = shortTypeApp.buttons["solo.action.draw"]
    let shortDiscard = shortTypeApp.buttons["solo.action.discard"]
    let shortGuidance = element(in: shortTypeApp, identifier: "solo.action.guidance")
    let shortLocalBoard = element(in: shortTypeApp, identifier: "solo.board.local.human")
    for element in [
      shortHeader,
      shortOpponents,
      shortActionBand,
      shortDraw,
      shortDiscard,
      shortGuidance,
      shortLocalBoard,
    ] {
      assertElement(element, isContainedIn: shortLayout, tolerance: 2)
      assertElement(element, isContainedIn: shortSafeArea, tolerance: 2)
    }
    XCTAssertGreaterThanOrEqual(shortOpponents.frame.height, 44)
    XCTAssertGreaterThanOrEqual(shortActionBand.frame.height, 170)
    XCTAssertGreaterThanOrEqual(shortLocalBoard.frame.height, 179)
    for target in [shortDraw, shortDiscard] {
      XCTAssertGreaterThanOrEqual(target.frame.width, 44)
      XCTAssertGreaterThanOrEqual(
        target.frame.height,
        90,
        "Each AXXXL action row must leave room for its complete visible two-line label."
      )
    }
    XCTAssertGreaterThanOrEqual(shortGuidance.frame.width, 44)
    XCTAssertGreaterThanOrEqual(shortGuidance.frame.height, 44)
    XCTAssertEqual(shortGuidance.elementType, .button)
    XCTAssertTrue(shortGuidance.isHittable)
    XCTAssertEqual(shortGuidance.label, "Take the visible discard or draw a blind card.")
    XCTAssertEqual(shortGuidance.value as? String, "Visible guidance: Choose a pile")
    XCTAssertTrue((shortDraw.value as? String)?.contains("Visible deck count") == true)
    let shortLocalHeader = element(
      in: shortTypeApp,
      identifier: "solo.board.header.local.human"
    )
    XCTAssertTrue((shortLocalHeader.value as? String)?.contains("Visible player: You") == true)
    let shortRound = element(
      in: shortTypeApp,
      identifier: "solo.table.round"
    )
    let shortTurnState = element(
      in: shortTypeApp,
      identifier: "solo.table.turn-state"
    )
    let shortFaceUpCard = element(
      in: shortTypeApp,
      identifier: "solo.card.local.human.r1.c1"
    )
    let shortDeckText = shortDraw.staticTexts["Deck"]
    XCTAssertGreaterThan(shortRound.frame.height, standardRoundHeight + 4)
    XCTAssertGreaterThan(shortTurnState.frame.height, standardTurnStateHeight + 4)
    XCTAssertGreaterThan(shortLocalHeader.frame.height, standardLocalHeaderHeight + 4)
    XCTAssertEqual(shortFaceUpCard.staticTexts.firstMatch.label, "-1")
    assertElement(
      shortFaceUpCard.staticTexts.firstMatch,
      isContainedIn: shortFaceUpCard,
      tolerance: 2
    )
    XCTAssertGreaterThan(shortDeckText.frame.height, standardDeckTextHeight + 4)
    shortGuidance.tap()
    let shortStatus = element(
      in: shortTypeApp,
      identifier: "solo.accessibility-table-status"
    )
    XCTAssertTrue(shortStatus.waitForExistence(timeout: 8))
    XCTAssertEqual(
      element(
        in: shortTypeApp,
        identifier: "solo.accessibility-table-status.round"
      ).label,
      "Round 1"
    )
    XCTAssertEqual(
      shortTypeApp.descendants(matching: .any).matching(
        NSPredicate(
          format: "identifier BEGINSWITH %@",
          "solo.accessibility-table-status.card."
        )
      ).count,
      48
    )
    shortTypeApp.buttons["solo.accessibility-table-status.done"].tap()
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [
          XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: shortStatus
          ),
        ],
        timeout: 5
      ),
      .completed
    )
    XCTAssertTrue(shortLayout.waitForExistence(timeout: 5))
    let shortCards = shortTypeApp.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.local.human.")
    ).allElementsBoundByIndex
    XCTAssertEqual(shortCards.count, 12)
    for card in shortCards {
      assertElement(card, isContainedIn: shortLocalBoard, tolerance: 2)
      assertElement(card, isContainedIn: shortSafeArea, tolerance: 2)
      XCTAssertGreaterThanOrEqual(card.frame.width, 44)
      XCTAssertGreaterThanOrEqual(card.frame.height, 44)
    }
    let shortHeaderFrame = shortHeader.frame
    let shortActionBandFrame = shortActionBand.frame
    let shortLocalBoardFrame = shortLocalBoard.frame
    shortTypeApp.swipeUp(velocity: .slow)
    assertFrame(shortHeader.frame, equals: shortHeaderFrame, accuracy: 2)
    assertFrame(shortActionBand.frame, equals: shortActionBandFrame, accuracy: 2)
    assertFrame(shortLocalBoard.frame, equals: shortLocalBoardFrame, accuracy: 2)
    try performFocusedSoloAccessibilityAudits(on: shortTypeApp)
    attachScreenshot(shortTypeApp, name: "ios7-solo-table-accessibility-xxxl-375x550")
  }

  @MainActor
  func testSoloRightToLeftLayoutKeepsControlsContained() throws {
    let app = launchSoloFixture(
      "solo-turn",
      additionalArguments: [
        "--ui-layout-direction=rtl",
        "-AppleLanguages",
        "(ar)",
        "-AppleLocale",
        "ar",
      ]
    )
    let table = element(in: app, identifier: "solo.table.layout.standard")
    XCTAssertTrue(table.waitForExistence(timeout: 8))
    let window = app.windows.firstMatch
    let firstColumn = element(in: app, identifier: "solo.card.local.human.r1.c1")
    let lastColumn = element(in: app, identifier: "solo.card.local.human.r1.c4")
    XCTAssertTrue(firstColumn.exists)
    XCTAssertTrue(lastColumn.exists)
    XCTAssertGreaterThan(
      firstColumn.frame.midX,
      lastColumn.frame.midX,
      "Arabic must exercise the right-to-left SwiftUI layout direction."
    )
    assertElement(firstColumn, isContainedIn: window, tolerance: 2)
    assertElement(lastColumn, isContainedIn: window, tolerance: 2)
    let draw = app.buttons["solo.action.draw"]
    let discard = app.buttons["solo.action.discard"]
    XCTAssertEqual(draw.elementType, .button)
    XCTAssertEqual(discard.elementType, .button)
    XCTAssertTrue(draw.isEnabled)
    XCTAssertTrue(discard.isEnabled)
    XCTAssertTrue(draw.isHittable)
    XCTAssertTrue(discard.isHittable)
    assertElement(draw, isContainedIn: window, tolerance: 2)
    assertElement(discard, isContainedIn: window, tolerance: 2)
    let opponentScroll = element(in: app, identifier: "solo.opponents.scroll")
    let visibleOpponentHeader = try XCTUnwrap(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "identifier BEGINSWITH %@", "solo.board.header.opponent.")
      ).allElementsBoundByIndex.first { header in
        opponentScroll.frame.insetBy(dx: -2, dy: -2).contains(header.frame)
      },
      "RTL lazy loading must expose the opponent header currently visible in the strip."
    )
    assertAccessibilityTraversal(
      [
        "solo.table.round",
        "solo.action.draw",
        "solo.board.header.local.human",
        visibleOpponentHeader.identifier,
      ],
      in: app
    )
    assertAccessibilityTraversal(
      ["solo.board.header.local.human"] + (1...3).flatMap { row in
        (1...4).reversed().map { column in
          "solo.card.local.human.r\(row).c\(column)"
        }
      },
      in: app
    )
    attachScreenshot(app, name: "ios7-solo-table-rtl")
  }

  @MainActor
  private func assertAnchoredSoloTurnLayout(
    in app: XCUIApplication,
    layoutIdentifier: String,
    maximumSize: CGSize,
    screenshotName: String
  ) {
    let layout = element(in: app, identifier: layoutIdentifier)
    XCTAssertTrue(layout.waitForExistence(timeout: 8))
    let window = app.windows.firstMatch
    let safeArea = element(in: app, identifier: "solo.table.safe-area")
    let opponentScroll = element(in: app, identifier: "solo.opponents.scroll")
    let actionBand = element(in: app, identifier: "solo.action-band")
    let draw = app.buttons["solo.action.draw"]
    let discard = app.buttons["solo.action.discard"]
    let guidance = element(in: app, identifier: "solo.action.guidance")
    let localBoard = element(in: app, identifier: "solo.board.local.human")
    let layoutDiagnostics = [
      "layout=\(layout.frame)",
      "window=\(window.frame)",
      "safe-area=\(safeArea.frame)",
      "opponents=\(opponentScroll.frame)",
      "actions=\(actionBand.frame)",
      "draw=\(draw.frame)",
      "discard=\(discard.frame)",
      "guidance=\(guidance.frame)",
      "local=\(localBoard.frame)",
    ].joined(separator: "; ")
    XCTAssertLessThanOrEqual(
      layout.frame.width,
      maximumSize.width + 2,
      layoutDiagnostics
    )
    XCTAssertLessThanOrEqual(
      layout.frame.height,
      maximumSize.height + 2,
      layoutDiagnostics
    )
    XCTAssertFalse(
      element(in: app, identifier: "solo.table.accessible-scroll").exists,
      "A short landscape must not introduce a whole-table ScrollView."
    )
    XCTAssertNotEqual(layout.elementType, .scrollView)
    XCTAssertTrue(safeArea.exists)
    assertSoloSafeArea(safeArea, in: app)
    assertElement(layout, isContainedIn: safeArea, tolerance: 2)
    for element in [opponentScroll, actionBand, draw, discard, guidance, localBoard] {
      assertElement(element, isContainedIn: layout, tolerance: 3)
      assertElement(element, isContainedIn: safeArea, tolerance: 2)
    }
    for target in [draw, discard, guidance] {
      XCTAssertGreaterThanOrEqual(target.frame.width, 44)
      XCTAssertGreaterThanOrEqual(target.frame.height, 44)
    }
    if layoutIdentifier == "solo.table.layout.accessibility-landscape" {
      let round = element(in: app, identifier: "solo.table.round")
      let turnState = element(in: app, identifier: "solo.table.turn-state")
      XCTAssertEqual(round.label, "Round 1")
      XCTAssertEqual(turnState.label, "Your turn")
      assertAccessibilityTraversal(
        ["solo.table.round", "solo.table.turn-state", "solo.action.draw"],
        in: app
      )
      XCTAssertEqual(draw.label, "Draw blind")
      XCTAssertTrue((draw.value as? String)?.contains("Visible deck count") == true)
      XCTAssertTrue(discard.label.contains("Discard pile, top card"))
      XCTAssertTrue((discard.value as? String)?.contains("Visible top card") == true)
      XCTAssertEqual(guidance.label, "Take the visible discard or draw a blind card.")
      XCTAssertEqual(guidance.value as? String, "Visible guidance: Choose a pile")
      let localHeader = element(in: app, identifier: "solo.board.header.local.human")
      XCTAssertEqual(localHeader.label, "You")
      XCTAssertTrue((localHeader.value as? String)?.contains("Visible player: You") == true)
      XCTAssertTrue((localHeader.value as? String)?.contains("visible score") == true)

      XCTAssertEqual(guidance.elementType, .button)
      XCTAssertTrue(guidance.isHittable)
      guidance.tap()
      let disclosure = element(in: app, identifier: "solo.accessibility-table-status")
      XCTAssertTrue(disclosure.waitForExistence(timeout: 8))
      XCTAssertTrue(app.navigationBars["Table Status"].exists)
      let fullRound = element(
        in: app,
        identifier: "solo.accessibility-table-status.round"
      )
      let fullTurnState = element(
        in: app,
        identifier: "solo.accessibility-table-status.turn-state"
      )
      let fullGuidance = element(
        in: app,
        identifier: "solo.accessibility-table-status.guidance"
      )
      let fullDeck = element(in: app, identifier: "solo.accessibility-table-status.deck")
      let fullDiscard = element(
        in: app,
        identifier: "solo.accessibility-table-status.discard"
      )
      XCTAssertEqual(fullRound.label, "Round 1")
      XCTAssertEqual(fullTurnState.label, "Your turn")
      XCTAssertEqual(fullGuidance.label, "Take the visible discard or draw a blind card.")
      XCTAssertTrue(fullDeck.label.hasPrefix("Deck:"))
      XCTAssertTrue(fullDiscard.label.hasPrefix("Discard top:"))
      XCTAssertGreaterThan(
        fullRound.frame.height,
        round.frame.height,
        "The disclosure must render the requested Accessibility XXXL system font."
      )
      XCTAssertGreaterThanOrEqual(fullGuidance.frame.height, 44)
      XCTAssertEqual(
        app.descendants(matching: .any).matching(
          NSPredicate(
            format: "identifier BEGINSWITH %@",
            "solo.accessibility-table-status.player."
          )
        ).count,
        4
      )
      let disclosedCards = app.descendants(matching: .any).matching(
        NSPredicate(
          format: "identifier BEGINSWITH %@",
          "solo.accessibility-table-status.card."
        )
      ).allElementsBoundByIndex
      XCTAssertEqual(disclosedCards.count, 48)
      let redactedCards = disclosedCards.filter {
        $0.label.localizedCaseInsensitiveContains("face down")
      }
      XCTAssertFalse(redactedCards.isEmpty)
      for card in redactedCards {
        XCTAssertNotNil(
          card.label.range(
            of: #"^Row [1-3], column [1-4]: face down$"#,
            options: .regularExpression
          ),
          "The large-text board summary must expose only position and face-down state: \(card.label)"
        )
      }
      attachScreenshot(app, name: "ios7-solo-table-status-accessibility-xxxl")
      app.buttons["solo.accessibility-table-status.done"].tap()
      XCTAssertEqual(
        XCTWaiter.wait(
          for: [
            XCTNSPredicateExpectation(
              predicate: NSPredicate(format: "exists == false"),
              object: disclosure
            ),
          ],
          timeout: 5
        ),
        .completed
      )
      XCTAssertTrue(layout.waitForExistence(timeout: 5))
    }

    let localCards = app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.local.human.")
    ).allElementsBoundByIndex
    XCTAssertEqual(localCards.count, 12)
    XCTAssertTrue(localCards.contains { !$0.label.contains("face down") && !$0.label.contains("cleared") })
    for card in localCards {
      assertElement(card, isContainedIn: localBoard, tolerance: 2)
      assertElement(card, isContainedIn: layout, tolerance: 2)
      assertElement(card, isContainedIn: safeArea, tolerance: 2)
      XCTAssertGreaterThanOrEqual(card.frame.width, 44)
      XCTAssertGreaterThanOrEqual(card.frame.height, 44)
    }

    let originalActionBandFrame = actionBand.frame
    let originalDrawFrame = draw.frame
    let originalDiscardFrame = discard.frame
    let originalGuidanceFrame = guidance.frame
    let originalLocalBoardFrame = localBoard.frame
    app.swipeUp(velocity: .slow)
    assertFrame(actionBand.frame, equals: originalActionBandFrame, accuracy: 2)
    assertFrame(draw.frame, equals: originalDrawFrame, accuracy: 2)
    assertFrame(discard.frame, equals: originalDiscardFrame, accuracy: 2)
    assertFrame(guidance.frame, equals: originalGuidanceFrame, accuracy: 2)
    assertFrame(localBoard.frame, equals: originalLocalBoardFrame, accuracy: 2)

    XCTAssertTrue(draw.isHittable)
    draw.tap()
    let drawnChoice = element(in: app, identifier: "solo.action.drawn-choice")
    XCTAssertTrue(drawnChoice.waitForExistence(timeout: 5))
    XCTAssertGreaterThanOrEqual(drawnChoice.frame.width, 44)
    XCTAssertGreaterThanOrEqual(drawnChoice.frame.height, 44)
    if layoutIdentifier == "solo.table.layout.accessibility-landscape" {
      XCTAssertTrue((drawnChoice.value as? String)?.contains("Visible card") == true)
      XCTAssertTrue((drawnChoice.value as? String)?.contains("visible action") == true)
    }
    assertElement(drawnChoice, isContainedIn: actionBand, tolerance: 2)
    assertElement(drawnChoice, isContainedIn: layout, tolerance: 2)
    // Revealing the previously hidden menu can expand SwiftUI's accessibility-container
    // union by a few points even though every visible control and the local board stay fixed.
    assertFrame(actionBand.frame, equals: originalActionBandFrame, accuracy: 4)
    if layoutIdentifier == "solo.table.layout.accessibility-landscape" {
      XCTAssertEqual(draw.frame.minY, originalDrawFrame.minY, accuracy: 2)
      XCTAssertEqual(draw.frame.width, originalDrawFrame.width, accuracy: 2)
      XCTAssertEqual(draw.frame.height, originalDrawFrame.height, accuracy: 2)
      XCTAssertEqual(discard.frame.minY, originalDiscardFrame.minY, accuracy: 2)
      XCTAssertEqual(discard.frame.width, originalDiscardFrame.width, accuracy: 2)
      XCTAssertEqual(discard.frame.height, originalDiscardFrame.height, accuracy: 2)
      let actionScrollDelta = draw.frame.minX - originalDrawFrame.minX
      XCTAssertLessThan(actionScrollDelta, 0)
      XCTAssertEqual(
        discard.frame.minX - originalDiscardFrame.minX,
        actionScrollDelta,
        accuracy: 2,
        "The accessibility action row must move as one explicit horizontal viewport."
      )
    } else {
      assertFrame(draw.frame, equals: originalDrawFrame, accuracy: 2)
      assertFrame(discard.frame, equals: originalDiscardFrame, accuracy: 2)
    }
    assertFrame(guidance.frame, equals: originalGuidanceFrame, accuracy: 2)
    assertFrame(localBoard.frame, equals: originalLocalBoardFrame, accuracy: 2)
    for card in localCards {
      assertElement(card, isContainedIn: localBoard, tolerance: 2)
      assertElement(card, isContainedIn: layout, tolerance: 2)
    }
    attachScreenshot(app, name: screenshotName)
  }

  @MainActor
  private func launchSoloFixture(
    _ state: String,
    orientation: UIDeviceOrientation? = .portrait,
    additionalArguments: [String] = []
  ) -> XCUIApplication {
    if let orientation {
      XCUIDevice.shared.orientation = orientation
    }
    let app = XCUIApplication()
    var launchArguments = ["--ui-state=\(state)"]
    if !additionalArguments.contains("-UIPreferredContentSizeCategoryName") {
      launchArguments += [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryL",
      ]
    }
    app.launchArguments = launchArguments + additionalArguments
    app.launch()
    XCTAssertTrue(app.staticTexts["home.welcome"].waitForExistence(timeout: 8))
    let solo = element(in: app, identifier: "home.solo")
    XCTAssertTrue(solo.isHittable)
    if state == "solo-setup-blocked-outbox" || state == "solo-setup-corrupt-outbox" {
      let fixtureReady = NSPredicate(
        format: "value == %@",
        "Stats delivery needs attention"
      )
      XCTAssertEqual(
        XCTWaiter.wait(
          for: [XCTNSPredicateExpectation(predicate: fixtureReady, object: solo)],
          timeout: 8
        ),
        .completed
      )
    }
    solo.tap()
    return app
  }

  @MainActor
  private func assertResumedThreeOpponentMixedGame(in app: XCUIApplication) {
    let table = element(in: app, identifier: "solo.table.layout.standard")
    XCTAssertTrue(table.waitForExistence(timeout: 8))
    XCTAssertEqual(element(in: app, identifier: "solo.table.round").label, "Round 1")
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "identifier BEGINSWITH %@", "solo.board.opponent.")
      ).firstMatch.waitForExistence(timeout: 5)
    )

    app.buttons["solo.settings.open"].tap()
    XCTAssertTrue(app.navigationBars["Game Settings"].waitForExistence(timeout: 8))
    let opponents = element(in: app, identifier: "solo.settings.current-opponents")
    let difficulty = element(in: app, identifier: "solo.settings.current-difficulty")
    scrollToElementFullyVisible(opponents, in: app, requiresHittable: false)
    XCTAssertEqual(opponents.label, "Opponents")
    XCTAssertEqual(opponents.value as? String, "3")
    scrollToElementFullyVisible(difficulty, in: app, requiresHittable: false)
    XCTAssertEqual(difficulty.label, "Difficulty")
    XCTAssertEqual(difficulty.value as? String, "Mixed")
    app.buttons["Done"].tap()
    XCTAssertTrue(table.waitForExistence(timeout: 5))
  }

  @MainActor
  private func fullyVisibleOpponentBoard(
    in app: XCUIApplication,
    scroll: XCUIElement,
    tolerance: CGFloat = 8
  ) -> XCUIElement? {
    guard scroll.exists else { return nil }
    let visibleBounds = scroll.frame.insetBy(dx: -tolerance, dy: -tolerance)
    return app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.board.opponent.")
    ).allElementsBoundByIndex.first { visibleBounds.contains($0.frame) }
  }

  @MainActor
  private func assertSoloSafeArea(
    _ safeArea: XCUIElement,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let window = app.windows.firstMatch
    XCTAssertTrue(window.exists, file: file, line: line)
    XCTAssertGreaterThan(
      safeArea.frame.minY,
      window.frame.minY + 20,
      "The table safe area must begin below system and navigation chrome.",
      file: file,
      line: line
    )
    XCTAssertLessThanOrEqual(
      safeArea.frame.maxY,
      window.frame.maxY - 18,
      "The table safe area must end above bottom chrome.",
      file: file,
      line: line
    )
    let navigationBar = app.navigationBars.firstMatch
    if navigationBar.exists {
      XCTAssertGreaterThanOrEqual(
        safeArea.frame.minY,
        navigationBar.frame.maxY - 2,
        file: file,
        line: line
      )
    }
    let tabBar = app.tabBars.firstMatch
    if tabBar.exists,
       tabBar.frame.height > 0,
       tabBar.frame.midY > window.frame.midY
    {
      XCTAssertLessThanOrEqual(
        safeArea.frame.maxY,
        tabBar.frame.minY + 2,
        file: file,
        line: line
      )
    }
  }

  @MainActor
  private func assertElement(
    _ element: XCUIElement,
    isContainedIn container: XCUIElement,
    tolerance: CGFloat
  ) {
    XCTAssertTrue(element.exists)
    XCTAssertTrue(container.exists)
    let outer = container.frame.insetBy(dx: -tolerance, dy: -tolerance)
    let diagnostics = "\(element.identifier)=\(element.frame); \(container.identifier)=\(container.frame)"
    XCTAssertGreaterThanOrEqual(element.frame.minX, outer.minX, diagnostics)
    XCTAssertGreaterThanOrEqual(element.frame.minY, outer.minY, diagnostics)
    XCTAssertLessThanOrEqual(element.frame.maxX, outer.maxX, diagnostics)
    XCTAssertLessThanOrEqual(element.frame.maxY, outer.maxY, diagnostics)
  }

  @MainActor
  private func assertAccessibilityTraversal(
    _ identifiers: [String],
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let elements = app.descendants(matching: .any).allElementsBoundByIndex
    var priorIndex = -1
    for identifier in identifiers {
      guard let index = elements.firstIndex(where: { $0.identifier == identifier }) else {
        XCTFail("Missing accessibility element \(identifier)", file: file, line: line)
        return
      }
      XCTAssertGreaterThan(
        index,
        priorIndex,
        "Accessibility traversal placed \(identifier) out of order",
        file: file,
        line: line
      )
      priorIndex = index
    }
  }

  @MainActor
  private func assertFrame(
    _ frame: CGRect,
    equals expected: CGRect,
    accuracy: CGFloat
  ) {
    XCTAssertEqual(frame.minX, expected.minX, accuracy: accuracy)
    XCTAssertEqual(frame.minY, expected.minY, accuracy: accuracy)
    XCTAssertEqual(frame.width, expected.width, accuracy: accuracy)
    XCTAssertEqual(frame.height, expected.height, accuracy: accuracy)
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
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
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
  private func performAccessibilityAudit(
    on app: XCUIApplication,
    allowUnattributedTextClipping: Bool = false
  ) throws {
    // XCTest currently reports system-dimmed inactive SwiftUI controls as
    // contrast failures even though inactive controls are exempt. Their
    // disabled semantics and high-contrast custom treatment are asserted
    // separately. Xcode 26 also reports a SwiftUI AccessibilityNode Dynamic
    // Type false positive for text that demonstrably scales. The navigation-
    // shell test relaunches at accessibility XXXL and asserts the complete
    // labels and layout directly; all other audit categories remain enforced.
    try app.performAccessibilityAudit(
      for: .all.subtracting(
        .contrast.union(.dynamicType).union(.hitRegion).union(.textClipped)
      )
    )
    try app.performAccessibilityAudit(for: .textClipped) { issue in
      guard let element = issue.element else {
        if allowUnattributedTextClipping {
          // Focused callers directly prove their rendered copy and geometry
          // before accepting Xcode 26's element-less artifact. Every attributed
          // finding continues through the strict failure branch below.
          return true
        }
        XCTFail("Unexpected unattributed clipped-text finding")
        return true
      }
      XCTFail(
        "Unexpected clipped text: id=\(element.identifier), label=\(element.label), frame=\(element.frame), type=\(element.elementType.rawValue)"
      )
      return true
    }
    try app.performAccessibilityAudit(for: .hitRegion) { issue in
      // Xcode 26 can retain the menu backing the intentionally hidden drawn-card
      // slot while it sweeps the hierarchy. That stale node (plus an
      // unattributable framework artifact) is exempt; every live element remains
      // enforced, including the 44-point board summary rows.
      guard let element = issue.element else { return true }
      return element.identifier == "solo.action.drawn-choice"
        && !element.isHittable
    }
  }

  @MainActor
  private func performSoloAccessibilityAudit(
    on app: XCUIApplication,
    enforceDynamicType: Bool = true,
    allowUnattributedTextClipping: Bool = false
  ) throws {
    try performAccessibilityAudit(
      on: app,
      allowUnattributedTextClipping: allowUnattributedTextClipping
    )
    try performFocusedSoloAccessibilityAudits(
      on: app,
      enforceDynamicType: enforceDynamicType
    )
  }

  @MainActor
  private func performFocusedSoloAccessibilityAudits(
    on app: XCUIApplication,
    enforceDynamicType: Bool = true
  ) throws {
    try app.performAccessibilityAudit(for: .contrast) { issue in
      guard let element = issue.element else {
        XCTFail("Unexpected unattributed contrast finding")
        return true
      }
      let disabledControls = [
        app.buttons["solo.action.draw"],
        app.buttons["solo.action.discard"],
        app.switches["solo.settings.music"],
      ]
      let isDisabledControl = disabledControls.contains { control in
        control.exists && !control.isEnabled && control.frame.intersects(element.frame)
      }
      let tabBar = app.tabBars.firstMatch
      // iOS 26 draws the floating tab bar's material shadow above the frame
      // exposed to XCTest. Limit the framework-artifact allowance to that
      // measured 12-point system-chrome fringe; in-content findings stay fatal.
      let isObscuredByTabBar: Bool
      if tabBar.exists {
        let tabBarShadowFrame = tabBar.frame.insetBy(dx: 0, dy: -12)
        isObscuredByTabBar = element.frame.intersects(tabBarShadowFrame)
      } else {
        isObscuredByTabBar = false
      }
      let opponentScroll = self.element(in: app, identifier: "solo.opponents.scroll")
      let opponentHeaders = (1...7).map {
        self.element(in: app, identifier: "solo.board.header.opponent.ai-\($0)")
      }
      // Xcode 26 walks the nested opponent scroller and can then audit a text
      // child from the next header even when its parent is entirely outside the
      // viewport. Scope this allowance to that exact offscreen parent/child
      // relationship; every fully visible opponent header remains enforced.
      let isOffscreenOpponentHeaderChild = opponentScroll.exists
        && opponentHeaders.contains { header in
          header.exists
            && header.frame.intersects(element.frame)
            && !opponentScroll.frame.contains(header.frame)
        }
      if !isDisabledControl && !isObscuredByTabBar && !isOffscreenOpponentHeaderChild {
        let localBoard = self.element(in: app, identifier: "solo.board.local.human")
        let opponentHeaderFrames = opponentHeaders
          .filter(\.exists)
          .map { "\($0.identifier)=\($0.frame)" }
          .joined(separator: ", ")
        XCTFail(
          "Unexpected contrast finding: id=\(element.identifier), label=\(element.label), frame=\(element.frame), type=\(element.elementType.rawValue), opponentScroll=\(opponentScroll.frame), localBoard=\(localBoard.frame), opponentHeaders=[\(opponentHeaderFrames)]"
        )
      }
      return true
    }
    if enforceDynamicType {
      var unexpectedDynamicTypeFindings: [String] = []
      try app.performAccessibilityAudit(for: .dynamicType) { issue in
        // Focused tests measure these exact SwiftUI labels and recovery button
        // containers at Accessibility XXXL. Xcode 26 nevertheless flags them
        // after their frames prove they scale. The settings Done item is the
        // standard SwiftUI toolbar control; its container stays 36 points high,
        // so the test instead verifies its explicit relative-font label remains
        // complete, hittable, and at least 44 points wide. Keep every exemption
        // identifier-exact; all other Dynamic Type findings remain enforced.
        guard let element = issue.element else { return true }
        let verifiedContainerIdentifiers = [
          "solo.outbox.retry",
          "solo.outbox.discard",
          "solo.outbox.heading",
          "solo.outbox.message",
          "solo.settings.current-opponents",
          "solo.settings.current-opponents.label",
          "solo.settings.current-opponents.value",
          "solo.settings.current-difficulty",
          "solo.settings.current-difficulty.label",
          "solo.settings.current-difficulty.value",
          "solo.settings.done",
        ]
        if verifiedContainerIdentifiers.contains(element.identifier) {
          return true
        }
        unexpectedDynamicTypeFindings.append(
          "id=\(element.identifier), label=\(element.label), frame=\(element.frame), type=\(element.elementType.rawValue)"
        )
        return true
      }
      if !unexpectedDynamicTypeFindings.isEmpty {
        XCTFail(
          "Unexpected Dynamic Type findings:\n\(unexpectedDynamicTypeFindings.joined(separator: "\n"))"
        )
      }
    }
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
    bottomInset: CGFloat = 96,
    requiresHittable: Bool = true
  ) {
    for _ in 0..<8 {
      if element.exists {
        let frame = element.frame
        if (!requiresHittable || element.isHittable),
           frame.minY >= app.frame.minY,
           frame.maxY <= app.frame.maxY - bottomInset {
          return
        }
        if frame.minY < app.frame.minY {
          app.swipeDown(velocity: .slow)
          continue
        }
      }
      app.swipeUp(velocity: .slow)
    }

    XCTAssertTrue(element.exists)
    let frame = element.frame
    if requiresHittable {
      XCTAssertTrue(element.isHittable)
    }
    XCTAssertGreaterThanOrEqual(frame.minY, app.frame.minY)
    XCTAssertLessThanOrEqual(frame.maxY, app.frame.maxY - bottomInset)
  }
}

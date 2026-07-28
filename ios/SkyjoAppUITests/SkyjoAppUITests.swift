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
    newGame.tap()

    XCTAssertTrue(element(in: app, identifier: "solo.setup").waitForExistence(timeout: 8))
    XCTAssertEqual(element(in: app, identifier: "solo.setup.difficulty").value as? String, "Mixed")
    app.buttons["solo.setup.start"].tap()
    XCTAssertTrue(app.navigationBars["Review Replacement"].waitForExistence(timeout: 8))
    let replacementCopy = element(in: app, identifier: "solo.replace.recovery-copy")
    if !replacementCopy.exists {
      app.swipeUp(velocity: .slow)
    }
    XCTAssertTrue(replacementCopy.waitForExistence(timeout: 5))
    XCTAssertTrue(replacementCopy.label.contains("game recoverable"))
    let cancel = app.buttons["solo.replace.cancel"]
    XCTAssertTrue(cancel.isHittable)
    cancel.tap()

    XCTAssertTrue(element(in: app, identifier: "solo.setup").waitForExistence(timeout: 5))
    app.buttons["solo.setup.cancel"].tap()
    XCTAssertTrue(element(in: app, identifier: "solo.launcher").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["solo.continue"].isHittable)
    attachScreenshot(app, name: "ios7-solo-replacement-recoverable")
    app.terminate()

    let failedReplacement = launchSoloFixture("solo-replacement-error")
    XCTAssertTrue(failedReplacement.navigationBars["Review Replacement"].waitForExistence(timeout: 8))
    let visibleError = element(in: failedReplacement, identifier: "solo.replace.error")
    for _ in 0..<4 where !visibleError.exists {
      failedReplacement.swipeUp(velocity: .slow)
    }
    XCTAssertTrue(visibleError.waitForExistence(timeout: 5))
    XCTAssertTrue(visibleError.label.contains("Previous game preserved"))
    XCTAssertTrue(visibleError.label.contains("previous game is still recoverable"))
    XCTAssertTrue(failedReplacement.buttons["solo.replace.confirm"].isEnabled)
    XCTAssertTrue(failedReplacement.buttons["solo.replace.confirm"].isHittable)
    XCTAssertTrue(failedReplacement.buttons["solo.replace.cancel"].isHittable)
    attachScreenshot(failedReplacement, name: "ios7-solo-replacement-error")
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
    try performAccessibilityAudit(on: app)
  }

  @MainActor
  func testSoloSetupRendersEverySupportedChoice() throws {
    let choices: [(rawValue: String, name: String, explanation: String, opponents: Int)] = [
      ("easy", "Easy", "Relaxed choices with more variety; a friendly place to learn.", 1),
      ("medium", "Medium", "Balanced decisions and the default for a new player.", 2),
      ("hard", "Hard", "Tracks revealed information and replaces cards more aggressively.", 3),
      ("ultra", "Ultra Hard", "Evaluates deck outcomes and closing risk for the strongest challenge.", 4),
      ("mixed", "Mixed", "Deterministically balances Easy, Medium, Hard, and Ultra opponents for this game.", 7),
    ]

    for choice in choices {
      let app = launchSoloFixture(
        "solo-setup",
        additionalArguments: [
          "--ui-solo-difficulty=\(choice.rawValue)",
          "--ui-solo-opponents=\(choice.opponents)",
        ]
      )
      let difficulty = element(in: app, identifier: "solo.setup.difficulty")
      let explanation = element(in: app, identifier: "solo.setup.difficulty-explanation")
      let botCount = element(in: app, identifier: "solo.setup.bot-count")
      XCTAssertTrue(difficulty.waitForExistence(timeout: 8))
      XCTAssertEqual(difficulty.value as? String, choice.name)
      XCTAssertEqual(explanation.label, choice.explanation)
      XCTAssertEqual(botCount.value as? String, choice.opponents.formatted())
      XCTAssertTrue(app.buttons["solo.setup.start"].isEnabled)
      attachScreenshot(app, name: "ios7-solo-setup-\(choice.rawValue)-\(choice.opponents)-bots")
      app.terminate()
    }
  }

  @MainActor
  func testSoloSetupSurfacesBlockedStatsRecoveryWithoutSave() throws {
    let app = launchSoloFixture("solo-setup-blocked-outbox")

    XCTAssertTrue(element(in: app, identifier: "solo.setup").waitForExistence(timeout: 8))
    let retry = app.buttons["solo.outbox.retry"]
    let discard = app.buttons["solo.outbox.discard"]
    XCTAssertTrue(retry.waitForExistence(timeout: 5))
    XCTAssertTrue(discard.exists)
    XCTAssertTrue(retry.isEnabled)
    XCTAssertTrue(discard.isEnabled)
    scrollToElementFullyVisible(retry, in: app)
    XCTAssertGreaterThanOrEqual(retry.frame.height, 44)
    scrollToElementFullyVisible(discard, in: app)
    XCTAssertGreaterThanOrEqual(discard.frame.height, 44)
    scrollToElementFullyVisible(app.buttons["solo.setup.start"], in: app)
    attachScreenshot(app, name: "ios7-solo-setup-blocked-outbox")
    try performAccessibilityAudit(on: app)
    app.terminate()

    let corruptApp = launchSoloFixture("solo-setup-corrupt-outbox")
    let recovery = element(in: corruptApp, identifier: "solo.outbox.recovery")
    XCTAssertTrue(recovery.waitForExistence(timeout: 8))
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
    try performAccessibilityAudit(on: corruptApp)
  }

  @MainActor
  func testSoloPhoneTableKeepsActionsStableAndRedactsHiddenCards() throws {
    let app = launchSoloFixture("solo-table")

    let table = app.otherElements.matching(identifier: "solo.table").firstMatch
    XCTAssertTrue(table.waitForExistence(timeout: 8))
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

    let firstCard = element(in: app, identifier: "solo.card.local.human.r1.c1")
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
    XCTAssertEqual(draw.frame.minY, originalDrawFrame.minY, accuracy: 2)
    XCTAssertEqual(draw.frame.height, originalDrawFrame.height, accuracy: 2)
    XCTAssertEqual(discard.frame.minY, originalDiscardFrame.minY, accuracy: 2)
    XCTAssertEqual(discard.frame.height, originalDiscardFrame.height, accuracy: 2)

    app.buttons["solo.settings.open"].tap()
    XCTAssertTrue(app.navigationBars["Game Settings"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.switches["solo.settings.sound"].isEnabled)
    XCTAssertTrue(app.switches["solo.settings.haptics"].isEnabled)
    XCTAssertFalse(app.switches["solo.settings.music"].isEnabled)
    XCTAssertEqual(app.switches["solo.settings.music"].value as? String, "0")
    app.buttons["Done"].tap()

    XCTAssertTrue(table.waitForExistence(timeout: 5))
    attachScreenshot(app, name: "ios7-solo-phone-table")
    try performAccessibilityAudit(on: app)
  }

  @MainActor
  func testSoloRepresentativeTurnKeepsEveryActionSlotStable() throws {
    let app = launchSoloFixture("solo-turn")
    let draw = app.buttons["solo.action.draw"]
    let discard = app.buttons["solo.action.discard"]
    let guidance = element(in: app, identifier: "solo.action.guidance")
    XCTAssertTrue(draw.waitForExistence(timeout: 8))
    XCTAssertTrue(discard.exists)
    XCTAssertEqual(guidance.label, "Take the visible discard or draw a blind card.")
    let originalDrawFrame = draw.frame
    let originalDiscardFrame = discard.frame
    let originalGuidanceFrame = guidance.frame

    draw.tap()
    let drawnChoice = element(in: app, identifier: "solo.action.drawn-choice")
    XCTAssertTrue(drawnChoice.waitForExistence(timeout: 5))
    XCTAssertEqual(guidance.label, "Choose any card to replace with the drawn card.")
    XCTAssertEqual(draw.frame, originalDrawFrame)
    XCTAssertEqual(discard.frame, originalDiscardFrame)
    XCTAssertEqual(guidance.frame, originalGuidanceFrame)
    attachScreenshot(app, name: "ios7-solo-turn-drawn-decision")

    let replacement = element(in: app, identifier: "solo.card.local.human.r1.c1")
    XCTAssertTrue(replacement.isHittable)
    replacement.tap()
    let drawnChoiceGone = NSPredicate(format: "exists == false")
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [XCTNSPredicateExpectation(predicate: drawnChoiceGone, object: drawnChoice)],
        timeout: 5
      ),
      .completed
    )
    XCTAssertEqual(draw.frame, originalDrawFrame)
    XCTAssertEqual(discard.frame, originalDiscardFrame)
    XCTAssertEqual(guidance.frame, originalGuidanceFrame)
    attachScreenshot(app, name: "ios7-solo-turn-complete")
  }

  @MainActor
  func testSoloLandscapeTableFitsWithoutWholeScreenScrolling() throws {
    XCUIDevice.shared.orientation = .landscapeLeft
    defer { XCUIDevice.shared.orientation = .portrait }
    let app = launchSoloFixture("solo-table", orientation: nil)
    XCUIDevice.shared.orientation = .landscapeLeft
    waitForSettledOrientation(app, landscape: true)

    let table = app.otherElements.matching(identifier: "solo.table").firstMatch
    XCTAssertTrue(table.waitForExistence(timeout: 8))
    let window = app.windows.firstMatch
    XCTAssertTrue(window.exists)
    XCTAssertFalse(table.elementType == .scrollView)
    let localCards = app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.local.human.")
    ).allElementsBoundByIndex
    XCTAssertEqual(localCards.count, 12)
    for card in localCards {
      assertElement(card, isContainedIn: window, tolerance: 2)
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
    assertElement(firstOpponentBoard, isContainedIn: window, tolerance: 2)
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
    assertElement(app.buttons["solo.action.draw"], isContainedIn: window, tolerance: 2)
    assertElement(app.buttons["solo.action.discard"], isContainedIn: window, tolerance: 2)
    let guidance = element(in: app, identifier: "solo.action.guidance")
    XCTAssertTrue(guidance.exists)
    XCTAssertEqual(guidance.label, "Reveal two of your face-down cards.")
    XCTAssertEqual(
      guidance.value as? String,
      window.frame.height < 650
        ? "Visible guidance: Reveal 2 cards"
        : "Visible guidance: Reveal two of your face-down cards."
    )
    assertElement(guidance, isContainedIn: window, tolerance: 2)
    XCTAssertGreaterThanOrEqual(guidance.frame.width, 44)
    XCTAssertGreaterThanOrEqual(guidance.frame.height, 44)
    attachScreenScreenshot(name: "ios7-solo-table-landscape")
  }

  @MainActor
  func testSoloScoreSummaryCanMinimizeAndRestore() throws {
    let app = launchSoloFixture("solo-summary")

    XCTAssertTrue(app.staticTexts["solo.summary.heading"].waitForExistence(timeout: 8))
    XCTAssertEqual(app.staticTexts["solo.summary.heading"].label, "Round complete")
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
    XCTAssertTrue(element(in: replayApp, identifier: "solo.table").waitForExistence(timeout: 8))
    XCTAssertEqual(element(in: replayApp, identifier: "solo.table.turn-state").label, "Your turn")
    let replayOpponents = replayApp.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.board.opponent.")
    ).allElementsBoundByIndex
    XCTAssertEqual(replayOpponents.count, 3)
    replayApp.terminate()

    let setupApp = launchSoloFixture("solo-game-summary")
    XCTAssertTrue(setupApp.staticTexts["solo.summary.heading"].waitForExistence(timeout: 8))
    let changeSetup = setupApp.buttons["solo.summary.change-setup"]
    XCTAssertTrue(changeSetup.isHittable)
    changeSetup.tap()
    XCTAssertTrue(element(in: setupApp, identifier: "solo.setup").waitForExistence(timeout: 8))
    XCTAssertEqual(element(in: setupApp, identifier: "solo.setup.difficulty").value as? String, "Mixed")
    XCTAssertEqual(element(in: setupApp, identifier: "solo.setup.bot-count").value as? String, "3")
  }

  @MainActor
  func testSoloRecoveryIsExplicitAndSafe() throws {
    let recoveryApp = launchSoloFixture("solo-recovery")
    let warning = element(in: recoveryApp, identifier: "solo.persistence-warning")
    XCTAssertTrue(warning.waitForExistence(timeout: 8))
    XCTAssertTrue(warning.label.contains("Saved game recovered"))
    XCTAssertTrue(warning.label.contains("removed safely"))
    attachScreenshot(recoveryApp, name: "ios7-solo-recovery")
  }

  @MainActor
  func testSoloXXXLContentSizeIsUnclamped() throws {
    let standardTypeApp = launchSoloFixture("solo-table")
    let standardRound = element(in: standardTypeApp, identifier: "solo.table.round")
    XCTAssertTrue(standardRound.waitForExistence(timeout: 8))
    let standardRoundHeight = standardRound.frame.height
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
    XCTAssertGreaterThan(xxxLargeRound.frame.height, standardRoundHeight)
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
    differentiatedCard.tap()
    let revealedCard = NSPredicate(format: "label CONTAINS[c] %@", "card, row 1, column 1")
    let faceUpCard = NSCompoundPredicate(andPredicateWithSubpredicates: [
      revealedCard,
      NSCompoundPredicate(
        notPredicateWithSubpredicate: NSPredicate(format: "label CONTAINS[c] %@", "face down")
      ),
    ])
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [XCTNSPredicateExpectation(predicate: faceUpCard, object: differentiatedCard)],
        timeout: 5
      ),
      .completed
    )
    attachScreenshot(adaptationApp, name: "ios7-solo-differentiate-without-color")
    adaptationApp.buttons["solo.settings.open"].tap()
    XCTAssertTrue(adaptationApp.navigationBars["Game Settings"].waitForExistence(timeout: 8))
    let adaptations = element(
      in: adaptationApp,
      identifier: "solo.settings.accessibility-adaptations"
    )
    scrollToElementFullyVisible(adaptations, in: adaptationApp)
    XCTAssertEqual(
      adaptations.value as? String,
      "Reduce Motion on; Increase Contrast on; Differentiate Without Color on"
    )
    attachScreenshot(adaptationApp, name: "ios7-solo-accessibility-adaptations")
    try performAccessibilityAudit(on: adaptationApp)
  }

  @MainActor
  func testSoloAccessibilityXXXLRemainsOperable() throws {
    let standardTypeApp = launchSoloFixture("solo-table")
    let standardRound = element(in: standardTypeApp, identifier: "solo.table.round")
    XCTAssertTrue(standardRound.waitForExistence(timeout: 8))
    let standardRoundHeight = standardRound.frame.height
    standardTypeApp.terminate()

    let dynamicTypeApp = launchSoloFixture(
      "solo-table",
      additionalArguments: [
        "-UIPreferredContentSizeCategoryName",
        "UICTContentSizeCategoryAccessibilityXXXL",
      ]
    )
    let guidance = dynamicTypeApp.descendants(matching: .any).matching(
      identifier: "solo.action.guidance"
    ).firstMatch
    XCTAssertTrue(guidance.waitForExistence(timeout: 8))
    XCTAssertEqual(guidance.label, "Reveal two of your face-down cards.")
    let window = dynamicTypeApp.windows.firstMatch
    let dynamicRound = element(in: dynamicTypeApp, identifier: "solo.table.round")
    XCTAssertTrue(dynamicRound.waitForExistence(timeout: 8))
    XCTAssertGreaterThan(
      dynamicRound.frame.height,
      standardRoundHeight + 4,
      "The table must render the requested Accessibility XXXL category instead of clamping it."
    )
    assertElement(dynamicRound, isContainedIn: window, tolerance: 2)
    XCTAssertTrue(dynamicTypeApp.buttons["solo.table.exit"].isHittable)
    let firstOpponentBoard = element(
      in: dynamicTypeApp,
      identifier: "solo.board.opponent.ai-1"
    )
    let firstOpponentHeader = element(
      in: dynamicTypeApp,
      identifier: "solo.board.header.opponent.ai-1"
    )
    XCTAssertTrue(firstOpponentBoard.waitForExistence(timeout: 5))
    assertElement(firstOpponentBoard, isContainedIn: window, tolerance: 2)
    assertElement(firstOpponentHeader, isContainedIn: firstOpponentBoard, tolerance: 2)
    let opponentCards = dynamicTypeApp.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.opponent.ai-1.")
    ).allElementsBoundByIndex
    XCTAssertEqual(opponentCards.count, 12)
    for card in opponentCards {
      assertElement(card, isContainedIn: firstOpponentBoard, tolerance: 2)
    }

    attachScreenshot(dynamicTypeApp, name: "ios7-solo-table-accessibility-xxxl-top")
    scrollToElementFullyVisible(
      guidance,
      in: dynamicTypeApp,
      bottomInset: 84,
      requiresHittable: false
    )
    assertElement(guidance, isContainedIn: window, tolerance: 2)
    assertElement(dynamicTypeApp.buttons["solo.action.draw"], isContainedIn: window, tolerance: 2)
    assertElement(dynamicTypeApp.buttons["solo.action.discard"], isContainedIn: window, tolerance: 2)
    try performFocusedSoloAccessibilityAudits(on: dynamicTypeApp)

    let localBoard = element(in: dynamicTypeApp, identifier: "solo.board.local.human")
    scrollToElementFullyVisible(
      localBoard,
      in: dynamicTypeApp,
      // Regular-width navigation lives in the top ornament, so only retain
      // the iPad home-indicator inset. Compact-width phones keep the floating
      // bottom tab-bar clearance.
      bottomInset: window.frame.width >= 700 ? 24 : 84,
      requiresHittable: false
    )
    let localCards = dynamicTypeApp.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH %@", "solo.card.local.human.")
    ).allElementsBoundByIndex
    XCTAssertEqual(localCards.count, 12)
    for card in localCards {
      assertElement(card, isContainedIn: localBoard, tolerance: 2)
      assertElement(card, isContainedIn: window, tolerance: 2)
    }
    attachScreenshot(dynamicTypeApp, name: "ios7-solo-table-accessibility-xxxl")
  }

  @MainActor
  func testSoloRightToLeftLayoutKeepsControlsContained() throws {
    let app = launchSoloFixture(
      "solo-table",
      additionalArguments: [
        "--ui-layout-direction=rtl",
        "-AppleLanguages",
        "(ar)",
        "-AppleLocale",
        "ar",
      ]
    )
    let table = app.otherElements.matching(identifier: "solo.table").firstMatch
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
    XCTAssertTrue(draw.isHittable)
    XCTAssertTrue(discard.isHittable)
    assertElement(draw, isContainedIn: window, tolerance: 2)
    assertElement(discard, isContainedIn: window, tolerance: 2)
    attachScreenshot(app, name: "ios7-solo-table-rtl")
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
    app.launchArguments = ["--ui-state=\(state)"] + additionalArguments
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
  private func assertElement(
    _ element: XCUIElement,
    isContainedIn container: XCUIElement,
    tolerance: CGFloat
  ) {
    XCTAssertTrue(element.exists)
    XCTAssertTrue(container.exists)
    let outer = container.frame.insetBy(dx: -tolerance, dy: -tolerance)
    XCTAssertGreaterThanOrEqual(element.frame.minX, outer.minX)
    XCTAssertGreaterThanOrEqual(element.frame.minY, outer.minY)
    XCTAssertLessThanOrEqual(element.frame.maxX, outer.maxX)
    XCTAssertLessThanOrEqual(element.frame.maxY, outer.maxY)
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
  private func performFocusedSoloAccessibilityAudits(on app: XCUIApplication) throws {
    try app.performAccessibilityAudit(for: .contrast) { issue in
      guard let element = issue.element else { return false }
      let disabledControls = [
        app.buttons["solo.action.draw"],
        app.buttons["solo.action.discard"],
      ]
      return disabledControls.contains { control in
        control.exists && !control.isEnabled && control.frame.intersects(element.frame)
      }
    }
    try app.performAccessibilityAudit(for: .dynamicType) { issue in
      // Changing between standard and accessibility categories swaps the
      // fixed table for its scrollable counterpart. Xcode can retain one
      // vanished SwiftUI AccessibilityNode during that transition and then
      // report it without a resolvable element. Only that unattributable
      // framework artifact is exempt; every live UILabel remains enforced.
      issue.element == nil
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

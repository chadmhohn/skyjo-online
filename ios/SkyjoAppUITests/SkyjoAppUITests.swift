import XCTest

final class SkyjoAppUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  @MainActor
  func testLaunchesTheNativeBootstrapWithoutAWebView() {
    let app = XCUIApplication()
    app.launch()

    XCTAssertTrue(app.staticTexts["bootstrap.title"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["bootstrap.ready"].exists)
    XCTAssertEqual(app.webViews.count, 0)
  }
}

import Foundation
import SwiftUI

@main
struct SkyjoNativeApp: App {
  @UIApplicationDelegateAdaptor(SkyjoAppDelegate.self) private var appDelegate
  private let configuration: Result<AppConfiguration, AppConfigurationError>

  init() {
    do {
      configuration = .success(try AppConfiguration(bundle: .main))
    } catch let error as AppConfigurationError {
      configuration = .failure(error)
    } catch {
      configuration = .failure(.invalidBaseURL(""))
    }
  }

  var body: some Scene {
    WindowGroup {
      Group {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-layout-direction=rtl") {
          BootstrapHomeView(configuration: configuration, notificationSystem: appDelegate)
            .environment(\.layoutDirection, .rightToLeft)
        } else {
          BootstrapHomeView(configuration: configuration, notificationSystem: appDelegate)
        }
#else
        BootstrapHomeView(configuration: configuration, notificationSystem: appDelegate)
#endif
      }
      .preferredColorScheme(.dark)
    }
  }
}

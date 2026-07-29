import Foundation
import SwiftUI

@main
struct SkyjoNativeApp: App {
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
#if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--ui-layout-direction=rtl") {
        BootstrapHomeView(configuration: configuration)
          .environment(\.layoutDirection, .rightToLeft)
      } else {
        BootstrapHomeView(configuration: configuration)
      }
#else
      BootstrapHomeView(configuration: configuration)
#endif
    }
  }
}

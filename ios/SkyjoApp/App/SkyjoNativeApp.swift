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
      BootstrapHomeView(configuration: configuration)
    }
  }
}

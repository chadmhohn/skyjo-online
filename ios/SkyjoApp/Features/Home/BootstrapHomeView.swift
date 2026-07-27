import SkyjoDesignSystem
import SwiftUI

struct BootstrapHomeView: View {
  let configuration: Result<AppConfiguration, AppConfigurationError>

  var body: some View {
    NavigationStack {
      VStack(spacing: 20) {
        Text("Skyjo")
          .font(.largeTitle.bold())
          .accessibilityIdentifier("bootstrap.title")

        SkyjoBootstrapBadge()

        switch configuration {
        case .success:
          Text("The native iPhone and iPad foundation is ready.")
            .multilineTextAlignment(.center)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("bootstrap.ready")
        case .failure(let error):
          ContentUnavailableView(
            "Configuration unavailable",
            systemImage: "exclamationmark.triangle",
            description: Text(error.localizedDescription)
          )
          .accessibilityIdentifier("bootstrap.configuration-error")
        }
      }
      .padding(24)
      .frame(maxWidth: 560)
      .navigationTitle("Home")
    }
    .tint(Color("AccentColor"))
  }
}

import SwiftUI

public enum SkyjoDesignSystemModule: Sendable {
  public static let name = "SkyjoDesignSystem"
}

@available(iOS 18.0, macOS 12.0, *)
public struct SkyjoBootstrapBadge: View {
  public init() {}

  public var body: some View {
    Label("Native foundation", systemImage: "rectangle.stack.fill")
      .font(.headline)
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .background(.thinMaterial, in: Capsule())
      .accessibilityIdentifier("bootstrap.native-badge")
  }
}

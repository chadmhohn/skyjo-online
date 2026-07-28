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

/// Presentation-safe card state. A face-down card cannot carry a value, so callers cannot
/// accidentally expose private information through text, identifiers, screenshots, or VoiceOver.
public enum SkyjoCardFace: Equatable, Sendable {
  case faceDown
  case faceUp(Int)
  case removed
}

@available(iOS 18.0, macOS 15.0, *)
public struct SkyjoCardView: View {
  private let face: SkyjoCardFace
  private let label: String
  private let hint: String?
  private let isEnabled: Bool
  private let aspectRatio: CGFloat
  private let action: () -> Void

  public init(
    face: SkyjoCardFace,
    label: String,
    hint: String? = nil,
    isEnabled: Bool = false,
    aspectRatio: CGFloat = 0.72,
    action: @escaping () -> Void = {}
  ) {
    self.face = face
    self.label = label
    self.hint = hint
    self.isEnabled = isEnabled
    self.aspectRatio = aspectRatio
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      ZStack {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(backgroundStyle)
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .strokeBorder(borderStyle, lineWidth: isEnabled ? 3 : 1.5)
        cardContent
      }
      .aspectRatio(aspectRatio, contentMode: .fit)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!isEnabled)
    .accessibilityLabel(label)
    .accessibilityHint(hint ?? "")
    .accessibilityAddTraits(isEnabled ? .isButton : [])
  }

  @ViewBuilder
  private var cardContent: some View {
    switch face {
    case .faceDown:
      Image(systemName: "sparkles.rectangle.stack.fill")
        .font(.title3.bold())
        .foregroundStyle(.white)
        .accessibilityHidden(true)
    case .faceUp(let value):
      Text(value.formatted())
        .font(.title3.monospacedDigit().bold())
        .minimumScaleFactor(0.6)
        .foregroundStyle(foregroundColor(for: value))
        .accessibilityHidden(true)
    case .removed:
      Image(systemName: "rectangle.dashed")
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
  }

  private var backgroundStyle: Color {
    switch face {
    case .faceDown:
      return Color.indigo
    case .faceUp(let value):
      switch value {
      case ...0: return Color.cyan.opacity(0.2)
      case 1...4: return Color.green.opacity(0.2)
      case 5...8: return Color.yellow.opacity(0.24)
      default: return Color.red.opacity(0.2)
      }
    case .removed:
      return Color.secondary.opacity(0.08)
    }
  }

  private var borderStyle: Color {
    isEnabled ? .accentColor : .secondary
  }

  private func foregroundColor(for value: Int) -> Color {
    value >= 9 ? .red : .primary
  }
}

@available(iOS 18.0, macOS 15.0, *)
public struct SkyjoStatusBanner: View {
  private let title: String
  private let message: String
  private let systemImage: String
  private let tint: Color

  public init(
    title: String,
    message: String,
    systemImage: String = "exclamationmark.triangle.fill",
    tint: Color = .orange
  ) {
    self.title = title
    self.message = message
    self.systemImage = systemImage
    self.tint = tint
  }

  public var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: systemImage)
        .foregroundStyle(tint)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.headline)
        Text(message).font(.subheadline)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    .overlay {
      RoundedRectangle(cornerRadius: 12)
        .stroke(tint, lineWidth: 1)
    }
    .accessibilityElement(children: .combine)
  }
}

@available(iOS 18.0, macOS 15.0, *)
public struct SkyjoActionSlot<Content: View>: View {
  private let isOccupied: Bool
  private let content: Content

  public init(
    isOccupied: Bool = true,
    @ViewBuilder content: () -> Content
  ) {
    self.isOccupied = isOccupied
    self.content = content()
  }

  public var body: some View {
    content
      .frame(maxWidth: .infinity, minHeight: 72, maxHeight: .infinity)
      .background(
        Color(uiColor: .secondarySystemGroupedBackground),
        in: RoundedRectangle(cornerRadius: 12)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 12)
          .stroke(Color.primary.opacity(0.28), lineWidth: 1)
      }
      .opacity(isOccupied ? 1 : 0)
      .accessibilityHidden(!isOccupied)
  }
}

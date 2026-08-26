import SwiftUI

public enum SkyjoDesignSystemModule: Sendable {
  public static let name = "SkyjoDesignSystem"
}

/// Product-level colors shared by every native Flipvale surface. These values mirror the
/// established web table without importing web assets or weakening native accessibility.
@available(iOS 18.0, macOS 15.0, *)
public enum FlipvaleTheme {
  public static let canvas = Color(red: 6 / 255, green: 12 / 255, blue: 10 / 255)
  public static let felt = Color(red: 10 / 255, green: 28 / 255, blue: 21 / 255)
  public static let feltHighlight = Color(red: 19 / 255, green: 51 / 255, blue: 38 / 255)
  public static let panel = Color.white.opacity(0.045)
  public static let panelStrong = Color(red: 16 / 255, green: 31 / 255, blue: 25 / 255)
  public static let ivory = Color(red: 245 / 255, green: 230 / 255, blue: 200 / 255)
  public static let mutedIvory = ivory.opacity(0.72)
  public static let gold = Color(red: 251 / 255, green: 191 / 255, blue: 36 / 255)
  public static let green = Color(red: 34 / 255, green: 197 / 255, blue: 94 / 255)
  public static let hairline = ivory.opacity(0.14)
}

@available(iOS 18.0, macOS 15.0, *)
public struct FlipvaleFeltBackground: View {
  public init() {}

  public var body: some View {
    ZStack {
      LinearGradient(
        colors: [FlipvaleTheme.felt, FlipvaleTheme.canvas],
        startPoint: .top,
        endPoint: .bottom
      )
      RadialGradient(
        colors: [FlipvaleTheme.ivory.opacity(0.075), .clear],
        center: .top,
        startRadius: 0,
        endRadius: 430
      )
      RadialGradient(
        colors: [FlipvaleTheme.green.opacity(0.07), .clear],
        center: .bottomTrailing,
        startRadius: 0,
        endRadius: 360
      )
    }
    .accessibilityHidden(true)
  }
}

@available(iOS 18.0, macOS 15.0, *)
public struct FlipvalePanelModifier: ViewModifier {
  private let isCurrent: Bool
  private let cornerRadius: CGFloat

  public init(isCurrent: Bool = false, cornerRadius: CGFloat = 16) {
    self.isCurrent = isCurrent
    self.cornerRadius = cornerRadius
  }

  public func body(content: Content) -> some View {
    content
      .background(
        isCurrent ? FlipvaleTheme.feltHighlight : FlipvaleTheme.panelStrong,
        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(
            isCurrent ? FlipvaleTheme.ivory.opacity(0.34) : FlipvaleTheme.hairline,
            lineWidth: isCurrent ? 1.5 : 1
          )
      }
      .shadow(color: .black.opacity(isCurrent ? 0.24 : 0.14), radius: 14, y: 8)
  }
}

@available(iOS 18.0, macOS 15.0, *)
extension View {
  public func flipvalePanel(isCurrent: Bool = false, cornerRadius: CGFloat = 16) -> some View {
    modifier(FlipvalePanelModifier(isCurrent: isCurrent, cornerRadius: cornerRadius))
  }

  public func flipvaleScreen() -> some View {
    background { FlipvaleFeltBackground().ignoresSafeArea() }
  }
}

@available(iOS 18.0, macOS 15.0, *)
public struct FlipvaleGroupBoxStyle: GroupBoxStyle {
  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      configuration.label
        .font(.system(.headline, design: .serif, weight: .bold))
        .foregroundStyle(FlipvaleTheme.ivory)
      configuration.content
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .flipvalePanel()
  }
}

@available(iOS 18.0, macOS 15.0, *)
public struct FlipvalePrimaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.headline.weight(.bold))
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
      .foregroundStyle(isEnabled ? FlipvaleTheme.canvas : FlipvaleTheme.mutedIvory)
      .background(
        isEnabled ? FlipvaleTheme.ivory : FlipvaleTheme.panelStrong,
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(isEnabled ? FlipvaleTheme.ivory : FlipvaleTheme.hairline, lineWidth: 1.5)
      }
      .shadow(color: .black.opacity(isEnabled ? 0.20 : 0), radius: 10, y: 5)
      .opacity(configuration.isPressed ? 0.78 : 1)
  }
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
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  private let face: SkyjoCardFace
  private let label: String
  private let hint: String?
  private let isEnabled: Bool
  private let aspectRatio: CGFloat
  private let usesDenseAccessibilityPresentation: Bool
  private let action: () -> Void

  public init(
    face: SkyjoCardFace,
    label: String,
    hint: String? = nil,
    isEnabled: Bool = false,
    aspectRatio: CGFloat = 0.72,
    usesDenseAccessibilityPresentation: Bool = false,
    action: @escaping () -> Void = {}
  ) {
    self.face = face
    self.label = label
    self.hint = hint
    self.isEnabled = isEnabled
    self.aspectRatio = aspectRatio
    self.usesDenseAccessibilityPresentation = usesDenseAccessibilityPresentation
    self.action = action
  }

  @ViewBuilder
  public var body: some View {
    if isEnabled {
      Button(action: action) {
        cardSurface
      }
      .buttonStyle(.plain)
      .accessibilityLabel(label)
      .accessibilityHint(hint ?? "")
    } else {
      cardSurface
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
  }

  private var cardSurface: some View {
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

  @ViewBuilder
  private var cardContent: some View {
    switch face {
    case .faceDown:
      FlipvaleCardBackMark(isDense: usesDenseAccessibilityGlyphs)
        .accessibilityHidden(true)
    case .faceUp(let value):
      // Card values are user-facing text, including in the compact accessibility
      // table. Keep one relative system style at every content-size category so
      // Accessibility XXXL is rendered rather than replaced by a fitted glyph.
      Text(value.formatted())
        .font(.caption2.monospacedDigit().weight(.black))
        .fixedSize(horizontal: true, vertical: true)
        // The tinted card surface already communicates the value band. Keep
        // every numeral adaptive-primary so 9–12 retain text contrast in both
        // color schemes and Increase Contrast.
        .foregroundStyle(Color.primary)
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
      return Color(red: 58 / 255, green: 68 / 255, blue: 145 / 255)
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
    if face == .faceDown {
      return isEnabled ? FlipvaleTheme.gold : FlipvaleTheme.ivory.opacity(0.72)
    }
    return isEnabled ? .accentColor : .secondary
  }

  private var usesDenseAccessibilityGlyphs: Bool {
    usesDenseAccessibilityPresentation
      || (dynamicTypeSize.isAccessibilitySize && verticalSizeClass == .compact)
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
        FlipvaleTheme.panelStrong,
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(FlipvaleTheme.hairline, lineWidth: 1)
      }
      .opacity(isOccupied ? 1 : 0)
      .allowsHitTesting(isOccupied)
      .accessibilityHidden(!isOccupied)
  }
}

@available(iOS 18.0, macOS 15.0, *)
public struct FlipvaleCardBackMark: View {
  private let isDense: Bool

  public init(isDense: Bool = false) {
    self.isDense = isDense
  }

  public var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: isDense ? 3 : 4, style: .continuous)
        .fill(FlipvaleTheme.ivory.opacity(0.18))
        .overlay {
          RoundedRectangle(cornerRadius: isDense ? 3 : 4, style: .continuous)
            .stroke(FlipvaleTheme.ivory.opacity(0.68), lineWidth: 1)
        }
        .offset(x: isDense ? -3 : -4, y: isDense ? -2 : -3)

      RoundedRectangle(cornerRadius: isDense ? 3 : 4, style: .continuous)
        .fill(FlipvaleTheme.ivory.opacity(0.92))
        .overlay {
          RoundedRectangle(cornerRadius: isDense ? 3 : 4, style: .continuous)
            .stroke(FlipvaleTheme.ivory, lineWidth: 1.25)
        }
        .offset(x: isDense ? 3 : 4, y: isDense ? 2 : 3)

      Text("FV")
        .font(.system(size: isDense ? 7 : 9, weight: .black, design: .rounded))
        .tracking(-0.6)
        .foregroundStyle(FlipvaleTheme.canvas)
        .offset(x: isDense ? 3 : 4, y: isDense ? 2 : 3)
    }
    .frame(width: isDense ? 24 : 30, height: isDense ? 28 : 34)
  }
}

import Foundation

public protocol SkyjoRandomNumberGenerator {
  mutating func nextUnitInterval() -> Double
}

public struct SeededRandom: SkyjoRandomNumberGenerator, Sendable {
  private var state: UInt32

  public init(seed: UInt32) {
    state = seed
  }

  public init(seed: Int) {
    state = UInt32(truncatingIfNeeded: seed)
  }

  public mutating func nextUnitInterval() -> Double {
    state &+= 0x6d2b_79f5
    var mixed = state
    mixed = (mixed ^ (mixed >> 15)) &* (mixed | 1)
    mixed ^= mixed &+ ((mixed ^ (mixed >> 7)) &* (mixed | 61))
    let result = mixed ^ (mixed >> 14)
    return Double(result) / 4_294_967_296
  }
}

public struct SystemSkyjoRandom: SkyjoRandomNumberGenerator {
  private var generator = SystemRandomNumberGenerator()

  public init() {}

  public mutating func nextUnitInterval() -> Double {
    Double.random(in: 0..<1, using: &generator)
  }
}

enum StableHash {
  static func fnv1a(_ value: String) -> UInt32 {
    var hash: UInt32 = 0x811c_9dc5
    for codeUnit in value.utf16 {
      hash ^= UInt32(codeUnit)
      hash = hash &* 0x0100_0193
    }
    return hash
  }
}

extension Array {
  mutating func skyjoShuffle<R: SkyjoRandomNumberGenerator>(using random: inout R) {
    guard count > 1 else { return }
    for index in stride(from: count - 1, through: 1, by: -1) {
      let swapIndex = Swift.min(Int(random.nextUnitInterval() * Double(index + 1)), index)
      swapAt(index, swapIndex)
    }
  }
}

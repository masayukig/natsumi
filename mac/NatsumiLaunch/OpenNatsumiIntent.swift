import AppIntents

/// Opens the app to wherever it was. Built into both the app and the widget
/// extension: the lock screen control names it, and the system runs it in the
/// app, which it brings to the front.
struct OpenNatsumiIntent: AppIntent {
    static let title: LocalizedStringResource = "会話を開く"
    static let supportedModes: IntentModes = .foreground

    func perform() async throws -> some IntentResult {
        .result()
    }
}

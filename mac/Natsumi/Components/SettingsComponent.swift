import AppKit
import NatsumiCore
import SwiftUI

/// The settings window, in the character's layer so that it opens without bringing the app to the front.
@MainActor
final class SettingsComponent: Component {
    let panel = OverlayPanel.make(style: [.titled, .closable], acceptsKey: true)
    private var applied: SettingsProps?
    private var hosting: NSHostingView<SettingsView>!
    /// Catches the next key while the shortcut is being recorded. It is the settings' own keyboard, like ⌘W is the
    /// conversation window's; what the key means is the mediator's to decide.
    private var recorder: Any?

    init() {
        super.init(name: "settings")
        hosting = NSHostingView(rootView: SettingsView(props: nil, send: sink))
        panel.title = "natsumi の設定"
        panel.isOpaque = true
        panel.backgroundColor = .windowBackgroundColor
        panel.contentView = hosting
        panel.onCancel = { [weak self] in self?.dispatch(.settingsCloseRequested) }
    }

    func render(_ props: SettingsProps) {
        guard props != applied else { return }
        // The panel is sized to what the form asks for: once, and again when the list of model routes changes length.
        let resize = applied?.modelRoutes.rows.count != props.modelRoutes.rows.count
        applied = props
        hosting.rootView = SettingsView(props: props, send: sink)
        record(props.isRecordingHotKey)
        if resize { panel.setContentSize(hosting.fittingSize) }
    }

    private func record(_ recording: Bool) {
        guard recording != (recorder != nil) else { return }
        guard recording else {
            recorder.map(NSEvent.removeMonitor)
            recorder = nil
            return
        }
        recorder = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.panel else { return event }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if event.keyCode == HotKey.KeyCode.escape, flags.isEmpty {
                self.dispatch(.hotKeyRecordingCancelled)
            } else {
                self.dispatch(.hotKeyRecorded(HotKey(keyCode: event.keyCode, modifiers: Self.modifiers(flags))))
            }
            return nil
        }
    }

    private static func modifiers(_ flags: NSEvent.ModifierFlags) -> HotKey.Modifiers {
        var modifiers: HotKey.Modifiers = []
        if flags.contains(.control) { modifiers.insert(.control) }
        if flags.contains(.option) { modifiers.insert(.option) }
        if flags.contains(.shift) { modifiers.insert(.shift) }
        if flags.contains(.command) { modifiers.insert(.command) }
        return modifiers
    }
}

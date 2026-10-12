import AppKit
import SwiftUI

/// A panel in the character's layer: above other windows and full-screen apps, on every Space, without activating
/// the app.
final class OverlayPanel: NSPanel {
    /// The conversation window and the settings take keyboard focus; the character and the balloon never do.
    var acceptsKey = false
    var onCancel: (() -> Void)?
    /// A ⌘-key the panel answers itself, by the key's lowercase letter. The app is never the active one, so its
    /// menu's shortcuts do not reach a key panel; what a panel wants from the keyboard it takes here.
    var onCommand: ((String) -> Bool)?
    /// A panel at the level of ordinary windows comes over them when the owner clicks into it. The app is never the
    /// active one, so nothing else would bring it forward (ADR 0078).
    var raisesWhenKey = false

    override var canBecomeKey: Bool { acceptsKey }

    override func becomeKey() {
        super.becomeKey()
        if raisesWhenKey { orderFrontRegardless() }
    }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           let key = event.charactersIgnoringModifiers?.lowercased(), onCommand?(key) == true
        {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    static func make(style: NSWindow.StyleMask = [.borderless], acceptsKey: Bool = false) -> OverlayPanel {
        let panel = OverlayPanel(
            contentRect: NSRect(x: 0, y: 0, width: 100, height: 100), styleMask: style.union(.nonactivatingPanel),
            backing: .buffered, defer: false)
        panel.acceptsKey = acceptsKey
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // `.borderless` is the empty mask, so `contains(.borderless)` is always true; test for a title bar instead.
        // A titled panel made clear and then opaque again draws none of its content.
        if !style.contains(.titled) {
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            // The comic panels are paper-white with black ink in both appearances.
            panel.appearance = NSAppearance(named: .aqua)
        }
        return panel
    }
}

extension NSView {
    func descendant(withIdentifier identifier: NSUserInterfaceItemIdentifier) -> NSView? {
        if self.identifier == identifier { return self }
        for subview in subviews {
            if let found = subview.descendant(withIdentifier: identifier) { return found }
        }
        return nil
    }
}

/// Buttons in a panel of an inactive app work on the first click. The panel's frame comes only from the layout: the
/// hosting view must not resize its window to the view's ideal size, which moves the panel off its place.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    required init(rootView: Content) {
        super.init(rootView: rootView)
        sizingOptions = []
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("not used")
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The stage's hosting view: the mouse works on the first click, the view never sizes its window, and the pointer
/// is seen moving over it even though the app is never the active one. While the stage is taking the mouse a global
/// monitor is blind to it, so the tracking area (`.activeAlways`) is what reports the pointer there — including the
/// moment it leaves what is drawn, which is when the stage stops taking the mouse.
final class StageHostingView<Content: View>: NSHostingView<Content> {
    var onPointer: @MainActor () -> Void = {}

    required init(rootView: Content) {
        super.init(rootView: rootView)
        sizingOptions = []
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("not used")
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(
            rect: .zero, options: [.activeAlways, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { onPointer() }
    override func mouseMoved(with event: NSEvent) { onPointer() }
    override func mouseExited(with event: NSEvent) { onPointer() }
}

/// A menu item that runs a closure.
final class ActionMenuItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(_ title: String, handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
        fatalError("not used")
    }

    @objc private func run() {
        // Menus call their actions on the main thread.
        let handler = handler
        MainActor.assumeIsolated { handler() }
    }
}

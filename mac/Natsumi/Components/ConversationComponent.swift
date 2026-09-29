import AppKit
import NatsumiCore
import SwiftUI

/// The conversation window (ADR 0021): a titled window of its own, not in the column and not a child of the
/// stage, with the input field at the bottom and the history unfolding above it. The text field and the unfold
/// button raise their own events; the window raises what belongs to the whole of it (⌘W, ⌘L, the connection's
/// button, a failed message).
@MainActor
final class ConversationComponent: Component {
    let panel = OverlayPanel.make(style: [.titled, .closable, .resizable], acceptsKey: true)
    private let field = Component(name: "conversation.field")
    private let toggle = Component(name: "conversation.toggle")
    private var applied: ConversationProps?
    private var hosting: FirstMouseHostingView<AnyView>!

    init() {
        super.init(name: "conversation")
        adopt(field)
        adopt(toggle)
        hosting = FirstMouseHostingView(rootView: AnyView(EmptyView()))
        panel.contentView = hosting
        // Opaque, so the conversation reads well over any window in both appearances.
        panel.isOpaque = true
        panel.backgroundColor = .windowBackgroundColor
        panel.minSize = NSSize(width: ConversationWindow.minWidth, height: ConversationWindow.minFoldedHeight)
        // The window takes its own shortcuts, so that they work while the app is not the active one.
        panel.onCommand = { [weak self] key in
            switch key {
            case "w": self?.dispatch(.conversationCloseRequested)
            case "l": self?.toggle.dispatch(.historyToggleRequested)
            default: return false
            }
            return true
        }
    }

    func render(_ props: ConversationProps?) {
        guard props != applied else { return }
        applied = props
        guard let props else { return }
        panel.title = props.title
        hosting.rootView = AnyView(ConversationView(props: props, field: field.sink, toggle: toggle.sink, send: sink))
        panel.minSize = NSSize(
            width: ConversationWindow.minWidth,
            height: props.history == nil ? ConversationWindow.minFoldedHeight : ConversationWindow.minUnfoldedHeight)
    }

    /// Brings the window to the front of its layer and puts the caret in the text field. The app stays where it is:
    /// the panel takes the keys without making the app the active one.
    func focus() {
        panel.orderFrontRegardless()
        panel.makeKey()
        if let text = panel.contentView?.descendant(withIdentifier: InputTextView.identifier) {
            panel.makeFirstResponder(text)
        }
    }
}

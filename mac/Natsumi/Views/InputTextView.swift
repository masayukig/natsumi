import AppKit
import NatsumiCore
import SwiftUI

/// An AppKit text view, so that the Enter that confirms Japanese input is left to the input method and long text
/// scrolls inside the box. It fills whatever it is given; the window's height is the owner's to set. Files pasted or
/// dropped into it are attached rather than written in as text (ADR 0071).
struct InputTextView: NSViewRepresentable {
    static let identifier = NSUserInterfaceItemIdentifier("natsumi.input")
    static let inset = NSSize(width: 4, height: 4)
    static let fontSize: CGFloat = 13

    @Binding var text: String
    let onSubmit: () -> Void
    let onFiles: ([PickedFile]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        let textView = AttachingTextView(frame: NSRect(origin: .zero, size: scroll.contentSize))
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: .greatestFiniteMagnitude)
        textView.onFiles = { context.coordinator.parent.onFiles($0) }
        scroll.documentView = textView
        textView.identifier = Self.identifier
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.textContainerInset = Self.inset
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.font = Comic.nsFont(Self.fontSize)
        // The window follows the appearance, and so does its text.
        textView.textColor = .textColor
        textView.insertionPointColor = .textColor
        textView.string = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scroll.documentView as? NSTextView else { return }
        if !textView.hasMarkedText(), textView.string != text { textView.string = text }
    }

    /// Takes files and pictures out of a paste or a drop. What has text is pasted as text, as it always was.
    final class AttachingTextView: NSTextView {
        var onFiles: (([PickedFile]) -> Void)?

        override func paste(_ sender: Any?) {
            guard let files = Self.files(on: .general) else { return super.paste(sender) }
            onFiles?(files)
        }

        override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
            guard let files = Self.files(on: sender.draggingPasteboard) else { return super.performDragOperation(sender) }
            onFiles?(files)
            return true
        }

        /// Files copied in the Finder, or a picture with no text with it (a screenshot, a copied image). nil when
        /// there are neither.
        static func files(on pasteboard: NSPasteboard) -> [PickedFile]? {
            let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
            let files = urls.compactMap(Uploader.picked)
            if !files.isEmpty { return files }
            guard pasteboard.string(forType: .string) == nil,
                  let data = pasteboard.data(forType: .png)
                    ?? pasteboard.data(forType: .tiff).flatMap({ NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) })
            else { return nil }
            return [PickedFile(name: "image.png", bytes: data.count, source: .data(data))]
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: InputTextView

        init(_ parent: InputTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            // While text is being composed, Enter belongs to the input method.
            guard !textView.hasMarkedText() else { return false }
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                    return true
                }
                parent.text = textView.string
                parent.onSubmit()
                return true
            default:
                return false
            }
        }
    }
}

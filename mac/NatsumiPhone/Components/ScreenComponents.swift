import NatsumiCore

/// The login screen: the server field and 「GitHub でログイン」.
@MainActor
final class LoginComponent: PhoneComponent {
    init() {
        super.init(name: "login")
    }
}

/// The main screen. Each part that raises something is a child of its own, so an event says where it came from.
/// The main screen raises the closing of a page itself: it is what the pages are pushed over.
@MainActor
final class MainComponent: PhoneComponent {
    /// The status at the top, when it offers to connect again.
    let status = PhoneComponent(name: "main.status")
    /// The history and settings buttons at the top right.
    let header = PhoneComponent(name: "main.header")
    /// The notice card, which opens the history.
    let notices = PhoneComponent(name: "main.notices")
    /// The count of approvals waiting, which opens their list.
    let approvals = PhoneComponent(name: "main.approvals")
    /// The × on her reply.
    let balloon = PhoneComponent(name: "main.balloon")
    /// The text field and the send button.
    let input = PhoneComponent(name: "main.input")
    /// The messages that could not be recorded, each with its ×.
    let failures = PhoneComponent(name: "main.failures")

    init() {
        super.init(name: "main")
        adopt(status)
        adopt(header)
        adopt(notices)
        adopt(approvals)
        adopt(balloon)
        adopt(input)
        adopt(failures)
    }
}

/// The history, pushed over the main screen.
@MainActor
final class HistoryComponent: PhoneComponent {
    /// The rows, which report coming into sight and going out of it.
    let rows = PhoneComponent(name: "history.rows")
    /// The small pictures in the rows, each of which opens large.
    let images = PhoneComponent(name: "history.images")
    /// The text field and the send button under the history.
    let input = PhoneComponent(name: "history.input")
    /// The messages not recorded yet, each with its × when it failed.
    let outgoing = PhoneComponent(name: "history.outgoing")

    init() {
        super.init(name: "history")
        adopt(rows)
        adopt(images)
        adopt(input)
        adopt(outgoing)
    }
}

/// The list of approvals waiting for the owner, pushed over the main screen.
@MainActor
final class ApprovalsComponent: PhoneComponent {
    /// The rows, each of which opens its approval.
    let rows = PhoneComponent(name: "approvals.rows")

    init() {
        super.init(name: "approvals")
        adopt(rows)
    }
}

/// One approval, pushed over the list. It raises going back to the list itself.
@MainActor
final class ApprovalComponent: PhoneComponent {
    /// The choice between the thread and the channel.
    let placement = PhoneComponent(name: "approval.placement")
    /// 承認・修正・却下.
    let actions = PhoneComponent(name: "approval.actions")
    /// The draft as a text field while the owner edits it, with its buttons.
    let editor = PhoneComponent(name: "approval.editor")
    /// The pictures that go with the post, each of which opens large.
    let images = PhoneComponent(name: "approval.images")

    init() {
        super.init(name: "approval")
        adopt(placement)
        adopt(actions)
        adopt(editor)
        adopt(images)
    }
}

/// A picture opened large over everything, with 「閉じる」 (ADR 0045).
@MainActor
final class ImageViewerComponent: PhoneComponent {
    init() {
        super.init(name: "imageViewer")
    }
}

/// The settings, pushed over the main screen.
@MainActor
final class SettingsComponent: PhoneComponent {
    /// Logging out, and connecting again when the connection offers it.
    let buttons = PhoneComponent(name: "settings.buttons")
    /// The model routes to choose from (ADR 0046).
    let routes = PhoneComponent(name: "settings.routes")

    init() {
        super.init(name: "settings")
        adopt(buttons)
        adopt(routes)
    }
}

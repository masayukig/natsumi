import Foundation

/// Everything the iPhone's UI is, in one value. Only the mediator changes it, and every drawing parameter is derived
/// from it.
public struct PhoneState {
    /// The connection and the conversation, as on the Mac.
    var session: SessionMachine

    public internal(set) var status: ConnectionStatus = .needsServer
    public internal(set) var hasSession = false
    public internal(set) var serverOrigin: String?
    /// What the login screen says about the server entered or the login that did not go through.
    public internal(set) var loginMessage: String?
    /// The server's avatar as this iPhone has it, and when to fetch it again (ADR 0057).
    public internal(set) var avatars = AvatarBook()

    /// The owner is in the text field of the main screen, with the keyboard over half of it.
    public internal(set) var isComposing = false
    /// The page over the main screen, if one is open.
    public internal(set) var page: PhonePage?
    /// The draft of the approval that is open is a text field.
    public internal(set) var isEditingApproval = false
    /// Where the owner chose to put the post of the approval that is open; nil until they choose.
    public internal(set) var approvalPlacement: ApprovalPlacement?
    /// The pictures fetched for the history and the approvals: the history's until the owner logs out, an
    /// approval's until it is no longer waiting (ADR 0045).
    public internal(set) var images = ImageShelf()
    /// The picture opened large over everything.
    public internal(set) var viewedImage: String?
    /// The rows of the history in sight, by message ID, while the history is open.
    var visibleHistoryIds: Set<String> = []
    /// Where this iPhone's notifications go. It outlives a session: the next login registers the same (ADR 0029).
    var pushRegistration: PushRegistration?
    /// The last tidying asked for while synced, so the same one is not asked for again. Cleared when the connection
    /// is left, so coming back tidies once more.
    var lastTidy: PushTidy?

    public var conversation: ConversationState { session.conversation }
    public var approvals: ApprovalBook { session.approvals }
    public var avatar: AvatarArt { avatars.art }

    /// The owner is reading the history: what is in sight there is read and checked.
    public var isReadingHistory: Bool { hasSession && page == .history }

    init(session: SessionMachine) {
        self.session = session
    }
}

/// A page pushed over the main screen.
public enum PhonePage: Equatable, Sendable {
    case history
    case settings
    /// The approvals waiting for the owner.
    case approvals
    /// One approval, pushed over the list.
    case approval(String)
}

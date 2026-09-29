import CoreGraphics
import Foundation

/// Where the connection to the server stands, as the owner is told about it.
public enum ConnectionStatus: Equatable, Sendable {
    case needsServer
    case needsLogin
    case loggingIn
    case connecting
    case connected
    case reconnecting
    case unavailable(String)
    /// A newer connection of this device took over.
    case replaced
    case stopped

    public var text: String {
        switch self {
        case .needsServer: "サーバーが未設定です"
        case .needsLogin: "ログインが必要です"
        case .loggingIn: "ログイン中…"
        case .connecting: "接続中…"
        case .connected: "接続しています"
        case .reconnecting: "再接続を待っています"
        case .unavailable(let code): "会話を使えません（\(code)）"
        case .replaced: "この端末の別の接続に切り替わりました"
        case .stopped: "接続を止めました"
        }
    }
}

/// The card whose whole text is shown. Only one is open at a time: opening another folds the one before.
public enum ExpandedCard: Equatable, Sendable {
    case reply(String)
    case notice(String)
}

/// Everything the UI is, in one value. Only the mediator changes it, and every drawing parameter is derived from
/// it; nothing else is kept anywhere in the tree.
public struct UIState {
    /// The connection and the conversation. The mediator hands the connection's own decisions to this machine and
    /// passes its effects on; what the owner sees is decided here.
    var session: SessionMachine

    public internal(set) var status: ConnectionStatus = .needsServer
    public internal(set) var hasSession = false
    public internal(set) var serverOrigin: String?
    public internal(set) var lastError: String?
    /// What the settings panel says about the server the owner just entered.
    public internal(set) var settingsMessage: String?

    /// The conversation window is on the screen (ADR 0021). Whether its history is unfolded is in the window.
    public internal(set) var isConversationOpen = false
    public internal(set) var isSettingsOpen = false

    public internal(set) var characterScale = CharacterScale.default
    /// The widest a panel in the column may be.
    public internal(set) var columnWidth = OverlaySettings.defaultColumnWidth
    /// Where the conversation window is and how large, in both of its states.
    public internal(set) var conversationWindow = ConversationWindow.default
    /// The visible area of the screen the conversation window is on, as the root last reported it; nil until the
    /// window has been on a screen, when it is the character's.
    public internal(set) var conversationVisible: CGRect?

    /// Where the character stands and which screen she is on, as the root last reported them. The mediator works
    /// out where she should go from these; it never asks the screen itself.
    public internal(set) var characterFrame: CGRect = .zero
    public internal(set) var visibleFrame: CGRect = .zero
    /// What she is doing, over and above her face.
    public internal(set) var motion: CharacterMotion = .still
    /// The way she last went sideways. Straight up and straight down keep it.
    var facing: RunDirection = .right
    var isDragging = false
    var isMoving = false
    /// Where she stood before she stepped out of the pointer's way. nil while she is in her own place, and her own
    /// place is never overwritten while this is set.
    var dodgeHome: CGPoint?
    /// The rectangle the root watches the pointer around, so that the same one is not asked for twice.
    var watchedPointerRect: CGRect?

    /// The global shortcut, or nil when there is none (ADR 0023).
    public internal(set) var hotKey: HotKey? = .default
    /// The settings are waiting for the owner to press the new shortcut. The old one is not registered meanwhile,
    /// so that it can be pressed as the new one.
    public internal(set) var isRecordingHotKey = false
    /// What the settings say about the shortcut: a key that cannot be one, or one another app has.
    public internal(set) var hotKeyMessage: String?

    /// The server's avatar as this Mac has it, and when to fetch it again (ADR 0057).
    public internal(set) var avatars = AvatarBook()

    /// The card the owner opened to read in full. It folds by itself when that card is no longer at the front.
    public internal(set) var expanded: ExpandedCard?
    /// The owner closed the thought bubble. One handling is one thing she is saying, so it stays closed for the
    /// whole of it — through every line and through the reply — and opens again once she has nothing to handle
    /// (ADR 0017).
    var isIndicatorDismissed = false
    /// The conversation window is the key window: the owner is using it.
    var isConversationKey = false
    /// The rows of the history in sight, by message ID, while the history is unfolded.
    var visibleHistoryIds: Set<String> = []
    /// The badge hid the bundle. Hiding checks nothing, and a notice not seen before brings it back.
    var noticesHidden = false
    var seenNoticeIds: Set<String> = []

    /// The pictures fetched for the balloon and the history, until the owner logs out (ADR 0045).
    public internal(set) var images = ImageShelf()
    /// The picture opened large, while its window is out.
    public internal(set) var viewedImage: String?

    public var conversation: ConversationState { session.conversation }
    public var avatar: AvatarArt { avatars.art }

    /// The owner is reading the history: the window is out, unfolded and the key one. What they see there is read,
    /// and the balloon keeps out of the way (ADR 0022).
    public var isReadingHistory: Bool {
        isConversationOpen && conversationWindow.showsHistory && isConversationKey
    }

    /// She is standing out of the pointer's way. Her own place is elsewhere, and must not be overwritten.
    public var isSteppedAside: Bool { dodgeHome != nil }

    init(session: SessionMachine) {
        self.session = session
    }
}

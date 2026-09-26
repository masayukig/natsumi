import CoreGraphics
import Foundation

/// What the app knows about itself when it starts: the settings it saved and where the avatar comes from.
public struct LaunchInfo: Equatable, Sendable {
    public var characterScale: CharacterScale
    public var columnWidth: CGFloat
    public var conversationWindow: ConversationWindow
    /// The global shortcut, or nil when the owner turned it off.
    public var hotKey: HotKey?
    /// The server the owner set, or nil when there is none yet.
    public var serverOrigin: String?
    public var avatarDirectory: String
    public var defaultAvatarDirectory: String

    public init(
        characterScale: CharacterScale, columnWidth: CGFloat = OverlaySettings.defaultColumnWidth,
        conversationWindow: ConversationWindow = .default, hotKey: HotKey? = .default, serverOrigin: String?,
        avatarDirectory: String, defaultAvatarDirectory: String
    ) {
        self.characterScale = characterScale
        self.columnWidth = columnWidth
        self.conversationWindow = conversationWindow
        self.hotKey = hotKey
        self.serverOrigin = serverOrigin
        self.avatarDirectory = avatarDirectory
        self.defaultAvatarDirectory = defaultAvatarDirectory
    }
}

/// How the browser sheet of the GitHub login ended.
public enum LoginOutcome: Equatable, Sendable {
    case succeeded
    case cancelled
    case failed(String)
}

/// Everything that can happen to the UI: what the owner does, and what the world outside reports.
///
/// Both enter the tree the same way. The owner's doings are raised by the component they happened in and bubble to
/// the root; the world's are handed to the root by the adapters. There is one entrance, and it is the mediator.
public enum UIEvent: Equatable, Sendable {
    // MARK: The app and the world outside

    case launched(LaunchInfo)
    /// The answer to `.resumeSession`: whether a live session is in the Keychain, and the device this Mac registered.
    case sessionResumed(hasSession: Bool, deviceId: String?)
    /// The server or the session went missing while connecting.
    case credentialsMissing
    case avatarLoaded(AvatarArt, description: String)
    case loginFinished(LoginOutcome)
    case socketOpened
    case socketReceived(Data)
    case socketClosed(CloseReason)
    case reconnectTimerFired
    /// The Mac woke from sleep. The socket may have died while it slept without a close ever arriving.
    case systemWoke

    // MARK: The character

    case characterClicked
    /// The yellow count at the character's top right.
    case badgeClicked
    /// Where she stands and which screen she is on. The root reports it whenever either changes; nothing is decided
    /// on it except which way she faces while the owner drags her.
    case characterFrameChanged(CGRect, visible: CGRect)
    case characterDragBegan
    case characterDragEnded
    /// A run the mediator asked for has arrived.
    case characterMoveFinished
    /// A display went away or changed size: what is on the screen now.
    case screenConfigurationChanged(visible: CGRect)
    /// The pointer has stayed by her long enough to look like it is on its way to what is underneath. It carries
    /// where it is once, for choosing where to go; the stream of moves stays in the root.
    case pointerCameNear(at: CGPoint)
    case pointerWentAway

    // MARK: The balloon

    case balloonTextClicked
    case balloonCloseClicked

    // MARK: The notices

    case noticeTextClicked
    case noticeCloseClicked

    /// "続きは履歴で", under a reply or a notice.
    case historyLinkClicked

    /// A URL in what she or the owner wrote, in the balloon, a notice or the history (ADR 0038).
    case linkClicked(URL)

    // MARK: The pictures (ADR 0045)

    /// A small picture, in the balloon or the history: it opens large in a window of its own.
    case imageClicked(imageId: String)
    /// The window of the large picture was closed.
    case imageViewerCloseRequested
    /// What came of a `.fetchImage`.
    case imageFetched(imageId: String, ImageFetch)

    // MARK: The conversation window

    case inputSubmitted(String)
    case outgoingDismissed(requestId: String)
    /// The button under the title bar, or ⌘L: the history unfolds above the input field, or folds away.
    case historyToggleRequested
    /// ⌘W or the title bar's close button.
    case conversationCloseRequested
    /// Where the window is and which screen it is on, after the owner moved or resized it, or after the screen
    /// gave it less than was asked for.
    case conversationFrameChanged(CGRect, visible: CGRect)
    /// The window became the key window, or stopped being it.
    case conversationKeyChanged(Bool)
    /// A row of the unfolded history came into sight or went out of it.
    case historyRowVisibilityChanged(messageId: String, isVisible: Bool)

    // MARK: The global shortcut (ADR 0023)

    /// The owner pressed the global shortcut, in whichever app they were.
    case hotKeyPressed
    /// The system would not take the shortcut: another app has it.
    case hotKeyRegistrationFailed(HotKey)

    // MARK: The menus and the settings

    case talkRequested
    case historyOpenRequested
    case readAllRepliesRequested
    case acknowledgeAllNoticesRequested
    case loginRequested
    case logoutRequested
    case reconnectRequested
    case settingsOpenRequested
    case settingsCloseRequested
    case serverSubmitted(String)
    case characterScaleChanged(CharacterScale)
    case avatarDirectorySubmitted(String)
    case avatarDirectoryResetRequested
    /// The shortcut's button in the settings: the next key pressed there is the new shortcut.
    case hotKeyRecordingRequested
    case hotKeyRecorded(HotKey)
    /// Esc while recording, the button pressed again, or the settings closed or left.
    case hotKeyRecordingCancelled
    case hotKeyCleared
    case hotKeyResetRequested
    /// A model route, in the settings or the menu: natsumi moves to it from her next turn (ADR 0046).
    case modelRouteChosen(String)
    case quitRequested
}

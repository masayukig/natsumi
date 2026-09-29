import Foundation

/// What the mediator asks the world outside to do. The mediator never does any of it: the root's adapters run these
/// and report back with events.
public enum UIEffect: Equatable, Sendable {
    // MARK: The connection (the session machine's own effects, passed on)

    case connect
    /// Close the socket and cancel a reconnect that is waiting.
    case disconnect
    case sendToServer(ClientEnvelope)
    case saveDeviceId(String)
    /// Keep the saved session until this time, if that is later than what is saved (ADR 0030).
    case extendSession(until: Date)
    case clearSession
    case scheduleReconnect(after: TimeInterval)

    // MARK: Storage, login and the avatar

    /// Look for a live session and answer with `.sessionResumed`.
    case resumeSession
    case startLogin
    case logout
    case saveServerAddress(ServerAddress)
    case saveCharacterScale(CharacterScale)
    case saveConversationWindow(ConversationWindow)
    /// nil saves that there is no shortcut.
    case saveHotKey(HotKey?)
    /// Read the copy of the avatar on this Mac and answer with `.avatarLoaded`.
    case loadAvatar
    /// `GET /v1/avatar` of this server, answered with `.avatarListingFetched` (ADR 0057).
    case fetchAvatarListing(origin: String)
    /// Fetch every file of the listing, check them, put them in place of the copy and answer with `.avatarReceived`.
    case receiveAvatar(origin: String, AvatarListing)

    // MARK: Panels, keyboard and the app

    /// Make the conversation window key and put the caret in the text field.
    case focusInput
    /// Run the character to this place, and answer with `.characterMoveFinished`.
    case moveCharacter(to: CGPoint)
    /// Stop a run in flight and leave her where it got to. Nothing is answered: whoever stopped it decides what
    /// happens next.
    case stopCharacterMove
    /// Remember where she stands as the place she starts in next time.
    case saveCharacterPlace
    /// Watch the pointer around this rectangle and report when it settles by it or leaves it; nil stops watching.
    case watchPointer(near: CGRect?)
    /// Register this as the global shortcut in place of the one before, or register none. A shortcut the system
    /// will not take is answered with `.hotKeyRegistrationFailed`.
    case registerHotKey(HotKey?)
    case showSettings
    case hideSettings
    /// Open a link in the default browser (ADR 0038).
    case openLink(URL)
    /// Fetch a picture with the session (`GET /v1/images/<imageId>`) and answer with `.imageFetched`.
    case fetchImage(imageId: String)
    case terminate
}

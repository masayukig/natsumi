import Foundation

/// Everything that can happen to the iPhone's UI: what the owner does, and what the world outside reports.
///
/// As on the Mac, both enter the tree the same way and end at one mediator (ADR 0028). The iPhone has no character
/// to drag, no windows and no shortcut, so it has its own, smaller set.
public enum PhoneEvent: Equatable, Sendable {
    // MARK: The app and the world outside

    /// The server the owner set, or nil when there is none yet.
    case launched(serverOrigin: String?)
    /// The answer to `.resumeSession`: whether a live session is in the Keychain, and the device this iPhone registered.
    case sessionResumed(hasSession: Bool, deviceId: String?)
    /// The server or the session went missing while connecting.
    case credentialsMissing
    case avatarLoaded(AvatarArt)
    case loginFinished(LoginOutcome)
    case socketOpened
    case socketReceived(Data)
    case socketClosed(CloseReason)
    case reconnectTimerFired
    /// The app came to the front. iOS stops what an app does behind others, so the connection is taken up again here.
    case becameActive
    /// The app went behind others, where iOS will soon stop it.
    case enteredBackground
    /// iOS gave a device token, and the key to seal notifications to is at hand (ADR 0029).
    case pushRegistrationReady(PushRegistration)
    /// A silent push said something was read or checked, most likely on another device.
    case backgroundPushReceived(BackgroundPush)
    /// A silent push said an approval was closed, here or on another device.
    case approvalResolvedPushReceived(ApprovalResolvedPush)
    /// The owner tapped the alert of an approval.
    case approvalNotificationOpened(approvalId: String)

    // MARK: The login screen

    /// 「GitHub でログイン」 with the server as the owner wrote it.
    case loginSubmitted(server: String)

    // MARK: The main screen

    /// The status at the top, when it offers to connect again.
    case reconnectRequested
    /// The history button at the top right, or the notice card.
    case historyOpenRequested
    /// The settings button at the top right.
    case settingsOpenRequested
    /// Back from the history or the settings, by the button or by the swipe.
    case pageClosed
    /// The × on her reply.
    case balloonCloseTapped
    /// The owner is in the text field, or has left it: the keyboard is up or gone (ADR 0028).
    case inputFocusChanged(Bool)
    case inputSubmitted(String)
    case outgoingDismissed(requestId: String)
    /// The count of approvals waiting, under the status.
    case approvalsOpenRequested

    // MARK: The history and the settings

    /// A row of the history came into sight or went out of it.
    case historyRowVisibilityChanged(messageId: String, isVisible: Bool)
    /// A URL in what she or the owner wrote, in the balloon or the history (ADR 0038).
    case linkTapped(URL)
    /// A small picture, in the history or on an approval: it opens large over everything (ADR 0045).
    case imageTapped(imageId: String)
    /// 「閉じる」 on the large picture.
    case imageViewerClosed
    /// What came of a `.fetchImage`.
    case imageFetched(imageId: String, ImageFetch)
    case logoutRequested
    /// A model route in the settings: natsumi moves to it from her next turn (ADR 0046).
    case modelRouteChosen(String)

    // MARK: The approvals

    /// A row of the list of approvals.
    case approvalOpenRequested(approvalId: String)
    /// Back from an approval to the list, by the button or by the swipe.
    case approvalClosed
    /// 「スレッド」 or 「チャンネル」 on the approval that is open.
    case approvalPlacementChosen(ApprovalPlacement)
    case approvalApproved(approvalId: String)
    case approvalRejected(approvalId: String)
    /// 「修正する」: the draft becomes a text field.
    case approvalEditRequested
    case approvalEditCancelled
    /// 「修正して送る」 with the text the owner wrote.
    case approvalEditSubmitted(approvalId: String, text: String)
}

/// What the iPhone's mediator asks the world outside to do. The root runs these and reports back with events.
public enum PhoneEffect: Equatable, Sendable {
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
    case saveServerAddress(ServerAddress)
    /// Tell the server the session is over and forget it here.
    case logout
    /// Read the avatar bundled with the app and answer with `.avatarLoaded`.
    case loadAvatar
    /// Open a link in the default browser (ADR 0038).
    case openLink(URL)
    /// Fetch a picture with the session (`GET /v1/images/<imageId>`) and answer with `.imageFetched`.
    case fetchImage(imageId: String)

    // MARK: Notifications (ADR 0029)

    /// Ask to show notifications and for a device token; the token comes back as `.pushRegistrationReady`.
    case registerForNotifications
    /// Set the badge and take away the delivered notifications of what was read or checked.
    case tidyNotifications(PushTidy)
}

/// The iPhone's tree.
public typealias PhoneComponent = TreeComponent<PhoneEvent>
public typealias PhoneEventSink = EventSinkOf<PhoneEvent>

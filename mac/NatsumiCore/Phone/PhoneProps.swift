import Foundation

/// A button the owner is offered on the iPhone, with the event it raises.
public struct PhoneActionProps: Equatable, Sendable {
    public var title: String
    public var event: PhoneEvent

    public init(title: String, event: PhoneEvent) {
        self.title = title
        self.event = event
    }
}

/// The login screen: her greeting, the server, and the one button.
public struct PhoneLoginProps: Equatable, Sendable {
    public var greeting: String
    /// The server as it was last saved; the field starts with it.
    public var serverOrigin: String
    /// Why the server was refused or the login did not go through.
    public var message: String?
    /// The browser sheet is up: the button cannot be pressed again.
    public var isLoggingIn: Bool
    public var buttonTitle: String
    /// Her face over the greeting, and the avatar it is drawn from.
    public var face: Expression
    public var avatar: AvatarArt

    public init(
        greeting: String, serverOrigin: String, message: String?, isLoggingIn: Bool, buttonTitle: String,
        face: Expression, avatar: AvatarArt
    ) {
        self.greeting = greeting
        self.serverOrigin = serverOrigin
        self.message = message
        self.isLoggingIn = isLoggingIn
        self.buttonTitle = buttonTitle
        self.face = face
        self.avatar = avatar
    }
}

/// How the dot beside the status is colored.
public enum PhoneStatusTone: Equatable, Sendable {
    case connected
    /// On its way: connecting, or waiting to connect again.
    case waiting
    /// Stopped until the owner does something.
    case trouble
}

/// The connection, at the top left of the main screen.
public struct PhoneStatusProps: Equatable, Sendable {
    public var text: String
    public var tone: PhoneStatusTone
    /// What tapping it does; nil when there is nothing to do about it.
    public var action: PhoneActionProps?

    public init(text: String, tone: PhoneStatusTone, action: PhoneActionProps?) {
        self.text = text
        self.tone = tone
        self.action = action
    }
}

/// The unchecked notices: the yellow card in front and the edges of the ones behind it.
public struct PhoneNoticeProps: Equatable, Sendable {
    /// The first line of the notice in front.
    public var text: String
    /// "未読 N 件": every unchecked notice.
    public var count: String
    /// Cards drawn behind the front one.
    public var edges: Int

    public init(text: String, count: String, edges: Int) {
        self.text = text
        self.count = count
        self.edges = edges
    }
}

/// Her last reply in the balloon, in full: the balloon's own text scrolls when it is long.
public struct PhoneReplyProps: Equatable, Sendable {
    /// "なつみ · 9:15".
    public var header: String
    public var text: String
    /// `text` with its URLs as links (ADR 0038).
    public var runs: [TextRun]
    /// She is still handling what the owner said: what she is thinking, in one line under the text (ADR 0025).
    public var thinking: ThinkingProps?

    public init(header: String, text: String, thinking: ThinkingProps?) {
        self.header = header
        self.text = text
        self.runs = TextLinks.runs(in: text)
        self.thinking = thinking
    }
}

/// What is over her head: her reply, or the thought bubble while she is receiving or thinking (ADR 0017).
public enum PhoneBalloonProps: Equatable, Sendable {
    case reply(PhoneReplyProps)
    case thought(ThinkingProps)
}

public struct PhoneCharacterProps: Equatable, Sendable {
    public var avatar: AvatarArt
    public var expression: Expression

    public init(avatar: AvatarArt, expression: Expression) {
        self.avatar = avatar
        self.expression = expression
    }
}

/// The whole conversation, pushed over the main screen. The rows are derived as on the Mac (ADR 0027).
public struct PhoneHistoryProps: Equatable, Sendable {
    public var history: HistoryProps

    public init(history: HistoryProps) {
        self.history = history
    }
}

/// The settings, pushed over the main screen.
public struct PhoneSettingsProps: Equatable, Sendable {
    public var serverOrigin: String
    public var status: PhoneStatusProps
    /// The ID the server gave this iPhone; empty until it has one.
    public var device: String
    /// The model routes, to see and to choose from (ADR 0046).
    public var modelRoutes: ModelRoutesProps

    public init(
        serverOrigin: String, status: PhoneStatusProps, device: String,
        modelRoutes: ModelRoutesProps = ModelRoutesProps(summary: "経路はまだ分かりません", menuTitle: "モデル: 不明")
    ) {
        self.serverOrigin = serverOrigin
        self.status = status
        self.device = device
        self.modelRoutes = modelRoutes
    }
}

/// The page open over the main screen.
public enum PhonePageProps: Equatable, Sendable {
    case history(PhoneHistoryProps)
    case settings(PhoneSettingsProps)
    case approvals(PhoneApprovalListProps)
    /// One approval, pushed over the list, and the list under it.
    case approval(PhoneApprovalPageProps, list: PhoneApprovalListProps)
}

/// The main screen: the only one where she moves.
public struct PhoneMainProps: Equatable, Sendable {
    public var status: PhoneStatusProps
    public var notices: PhoneNoticeProps?
    /// How many approvals are waiting, when any are.
    public var approvals: PhoneApprovalEntryProps?
    public var balloon: PhoneBalloonProps?
    public var character: PhoneCharacterProps
    /// Messages the server has not recorded yet, over the input field: while the owner is writing, all of them, so
    /// that what was just sent is seen going; otherwise only the ones that could not be recorded.
    public var outgoing: [OutgoingRowProps]
    /// The owner is writing, with the keyboard over half the screen: she is drawn as a face beside what she says,
    /// and the notices keep out of the way.
    public var isComposing: Bool
    /// The history or the settings when one is open over it.
    public var page: PhonePageProps?
    /// A picture opened large over everything, with 「閉じる」.
    public var viewer: ImageViewerProps?

    public init(
        status: PhoneStatusProps, notices: PhoneNoticeProps?, balloon: PhoneBalloonProps?,
        character: PhoneCharacterProps, outgoing: [OutgoingRowProps], isComposing: Bool = false,
        page: PhonePageProps? = nil, approvals: PhoneApprovalEntryProps? = nil, viewer: ImageViewerProps? = nil
    ) {
        self.status = status
        self.notices = notices
        self.approvals = approvals
        self.balloon = balloon
        self.character = character
        self.outgoing = outgoing
        self.isComposing = isComposing
        self.page = page
        self.viewer = viewer
    }
}

/// Which screen is up. Without a session there is only the login.
public enum PhoneScreen: Equatable, Sendable {
    case login(PhoneLoginProps)
    case main(PhoneMainProps)
}

/// Everything the iPhone's tree draws, in one value.
public struct PhoneRootProps: Equatable, Sendable {
    public var screen: PhoneScreen

    public init(screen: PhoneScreen) {
        self.screen = screen
    }
}

/// The iPhone's drawing parameters, derived from the mediator's state by pure functions. What is read and shown is
/// decided by the same rules as on the Mac (`UIProps`); only the way it is laid out differs.
public enum PhoneProps {
    /// `time` is when this is drawn, for the time beside her reply.
    public static func root(_ state: PhoneState, time: MessageTime) -> PhoneRootProps {
        guard state.hasSession else { return PhoneRootProps(screen: .login(login(state))) }
        let conversation = state.conversation
        return PhoneRootProps(screen: .main(PhoneMainProps(
            status: status(state.status),
            notices: state.isComposing ? nil : notices(conversation),
            balloon: balloon(conversation, time: time),
            character: PhoneCharacterProps(avatar: state.avatar, expression: face(conversation, isComposing: state.isComposing)),
            outgoing: outgoing(conversation, isComposing: state.isComposing), isComposing: state.isComposing,
            page: page(state, time: time), approvals: PhoneApprovalProps.entry(state), viewer: viewer(state))))
    }

    /// The picture opened large, while it is here to show.
    static func viewer(_ state: PhoneState) -> ImageViewerProps? {
        guard let id = state.viewedImage, case .loaded(let image) = state.images[id] else { return nil }
        return ImageViewerProps(image: image, title: "なつみの画像")
    }

    /// Standing, she wears the face the server gives her. While the owner writes she is a face beside her reply, so
    /// she wears the feeling she put into that line (ADR 0026), when it is known.
    static func face(_ conversation: ConversationState, isComposing: Bool) -> Expression {
        guard isComposing, let feeling = UIProps.shownReply(conversation, readingHistory: false)?.expression else {
            return conversation.expression
        }
        return feeling
    }

    /// What is over the input field. While the owner is writing, the message just sent is there with 「受付中…」 under
    /// it; otherwise only what could not be recorded is, to be read and dismissed.
    static func outgoing(_ conversation: ConversationState, isComposing: Bool) -> [OutgoingRowProps] {
        conversation.outbox.compactMap { item in
            let failure: String? = switch item.status {
            case .sending: nil
            case .rejected(let code), .unavailable(let code): "送れませんでした（\(code)）"
            }
            guard isComposing || failure != nil else { return nil }
            return OutgoingRowProps(requestId: item.requestId, text: item.text, failure: failure)
        }
    }

    /// Only the page that is open is derived: the history is the costly one.
    static func page(_ state: PhoneState, time: MessageTime) -> PhonePageProps? {
        switch state.page {
        case .history:
            .history(PhoneHistoryProps(history: UIProps.history(
                state.conversation, time: time, avatar: state.avatar, images: state.images, strip: .phoneHistory,
                openHelp: "タップで拡大")))
        case .settings:
            .settings(PhoneSettingsProps(
                serverOrigin: state.serverOrigin ?? "", status: status(state.status),
                device: state.session.deviceId ?? "",
                modelRoutes: UIProps.modelRoutes(state.session.modelRoutes, isConnected: state.status == .connected)))
        case .approvals:
            .approvals(PhoneApprovalProps.list(state, time: time))
        case .approval(let id):
            .approval(PhoneApprovalProps.page(state, id: id, time: time), list: PhoneApprovalProps.list(state, time: time))
        case nil:
            nil
        }
    }

    static func login(_ state: PhoneState) -> PhoneLoginProps {
        let isLoggingIn = state.status == .loggingIn
        return PhoneLoginProps(
            greeting: state.serverOrigin == nil
                ? "はじめまして。どこのサーバーにつなぐか教えてね。" : "おかえり。もう一度ログインしてね。",
            serverOrigin: state.serverOrigin ?? "", message: state.loginMessage, isLoggingIn: isLoggingIn,
            buttonTitle: isLoggingIn ? "ログイン中…" : "GitHub でログイン", face: .happy, avatar: state.avatar)
    }

    static func status(_ status: ConnectionStatus) -> PhoneStatusProps {
        switch status {
        case .connected:
            PhoneStatusProps(text: "つながっています", tone: .connected, action: nil)
        case .connecting, .reconnecting, .loggingIn:
            PhoneStatusProps(text: status.text, tone: .waiting, action: nil)
        case .replaced, .stopped, .unavailable:
            PhoneStatusProps(
                text: status.text, tone: .trouble,
                action: PhoneActionProps(title: "接続し直す", event: .reconnectRequested))
        case .needsServer, .needsLogin:
            PhoneStatusProps(text: status.text, tone: .trouble, action: nil)
        }
    }

    static func notices(_ conversation: ConversationState) -> PhoneNoticeProps? {
        guard let stack = UIProps.noticeStack(conversation) else { return nil }
        let text = switch stack.front {
        case .notice(let message):
            String(BalloonText.whole(message.text).prefix { $0 != "\n" })
        case .older(let ids):
            // Their text is older than the history, so there is nothing to show but how many.
            "前の知らせが \(ids.count) 件あります（本文は履歴より前のため出せません）"
        }
        return PhoneNoticeProps(text: text, count: "未読 \(stack.count) 件", edges: stack.behind)
    }

    /// Her last reply while it is unread, whole, with what she is thinking under it while she is still at it
    /// (ADR 0022, ADR 0025); otherwise the thought bubble while she is receiving or thinking (ADR 0017).
    static func balloon(_ conversation: ConversationState, time: MessageTime) -> PhoneBalloonProps? {
        let thinking = UIProps.indicator(conversation).map { indicator in
            ThinkingProps(label: indicator == .receiving ? "受付中" : "考え中", line: conversation.thinkingLine)
        }
        guard let last = UIProps.shownReply(conversation, readingHistory: false) else {
            return thinking.map { .thought($0) }
        }
        let at = time.labels([last.date]).first ?? nil
        return .reply(PhoneReplyProps(
            header: at.map { "なつみ · \($0)" } ?? "なつみ", text: BalloonText.whole(last.text), thinking: thinking))
    }
}

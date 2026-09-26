import CoreGraphics
import Foundation

/// What the layout decided about the column, and the widest a panel in it may be. The panels are measured with it
/// and then drawn with it, so it is an input of the derivation, not a part of the state.
public struct ColumnPlacement: Equatable, Sendable {
    public var tail: BalloonTail
    /// The tail's position from the balloon's left side.
    public var tailX: CGFloat
    public var budget: StackBudget
    /// The widest a panel in the column may be; a setting the owner keeps.
    public var width: CGFloat
    /// What an opened card may widen to. Cards that are not open keep to `width`.
    public var expandedWidth: CGFloat
    /// The height the layout gave each card's panel. A card draws its box at exactly this height, so that opening
    /// and folding animate the one number the panel will end up at and arrive there together with it. nil while the
    /// cards are being measured, which is what settles these heights in the first place.
    public var balloonHeight: CGFloat?
    public var noticesHeight: CGFloat?

    public init(
        tail: BalloonTail = .down, tailX: CGFloat = 40, budget: StackBudget = .full,
        width: CGFloat = OverlaySettings.defaultColumnWidth, expandedWidth: CGFloat = OverlaySettings.defaultColumnWidth
    ) {
        self.tail = tail
        self.tailX = tailX
        self.budget = budget
        self.width = width
        self.expandedWidth = expandedWidth
    }
}

/// A button the owner is offered, with the event it raises.
public struct ActionProps: Equatable, Sendable {
    public var title: String
    public var event: UIEvent

    public init(title: String, event: UIEvent) {
        self.title = title
        self.event = event
    }
}

/// The connection and what to do about it.
public struct StatusProps: Equatable, Sendable {
    public var text: String
    public var action: ActionProps?

    public init(text: String, action: ActionProps?) {
        self.text = text
        self.action = action
    }
}

public struct BadgeProps: Equatable, Sendable {
    public var count: Int
    /// Where the badge sits in the character's view, with the origin at the top left.
    public var frame: CGRect
    public var help: String

    public init(count: Int, frame: CGRect, help: String) {
        self.count = count
        self.frame = frame
        self.help = help
    }
}

public struct CharacterProps: Equatable, Sendable {
    public var scale: CharacterScale
    public var avatar: AvatarArt
    public var expression: Expression
    /// What she is doing while she wears that face. Moving is drawn with running art instead.
    public var motion: CharacterMotion
    /// The small grey mark and what it says; nil while connected.
    public var disconnectedHelp: String?
    public var badge: BadgeProps?

    public init(
        scale: CharacterScale, avatar: AvatarArt, expression: Expression, motion: CharacterMotion = .still,
        disconnectedHelp: String?, badge: BadgeProps?
    ) {
        self.scale = scale
        self.avatar = avatar
        self.expression = expression
        self.motion = motion
        self.disconnectedHelp = disconnectedHelp
        self.badge = badge
    }
}

/// natsumi's last reply, in the balloon while it is unread (ADR 0022).
public struct ReplyProps: Equatable, Sendable {
    public var text: String
    /// `text` with its URLs as links (ADR 0038).
    public var runs: [TextRun]
    public var lineLimit: Int
    /// The owner opened this one, so `text` is the whole reply.
    public var isExpanded: Bool
    /// "続きは履歴で": the text is cut, or the column had to show fewer lines.
    public var showsHistoryLink: Bool
    /// "未読 N 件": every unread reply, this one included.
    public var unread: Int
    public var help: String
    /// She is still handling what the owner said after sending this: what she is thinking, in one line under the
    /// text (ADR 0025). nil when she has finished, or when the owner closed the thought bubble for this handling.
    public var thinking: ThinkingProps?
    /// The pictures she attached, small, under the text (ADR 0045). Their sizes are fixed before they come, so the
    /// balloon does not change size when they do.
    public var images: [ImageTileProps]

    public init(
        text: String, runs: [TextRun]? = nil, lineLimit: Int, isExpanded: Bool = false, showsHistoryLink: Bool,
        unread: Int, help: String, thinking: ThinkingProps? = nil, images: [ImageTileProps] = []
    ) {
        self.text = text
        self.runs = runs ?? TextLinks.runs(in: text)
        self.lineLimit = lineLimit
        self.isExpanded = isExpanded
        self.showsHistoryLink = showsHistoryLink
        self.unread = unread
        self.help = help
        self.thinking = thinking
        self.images = images
    }
}

/// The outline the balloon is drawn with. What she says out loud is a speech balloon; what she is thinking is the
/// comic thought bubble, with small circles leading to her in place of a tail (ADR 0017).
public enum BalloonOutline: Equatable, Sendable {
    case speech
    case thought
}

/// The thought bubble: what she is doing, and the line she is writing this moment.
public struct ThinkingProps: Equatable, Sendable {
    /// 受付中 before the server has the message, 考え中 once she is handling it.
    public var label: String
    /// The newest line of her thinking, or nil until one arrives. It is drawn in one line at the bubble's own
    /// width, whatever its length, so the bubble never changes size for it.
    public var line: String?

    public init(label: String, line: String?) {
        self.label = label
        self.line = line
    }
}

public struct BalloonProps: Equatable, Sendable {
    public enum Body: Equatable, Sendable {
        /// natsumi is receiving or handling something. Her thinking comes before her replies (ADR 0017).
        case thinking(ThinkingProps)
        case reply(ReplyProps)

        /// Whether the reply is opened to its whole text.
        public var isExpanded: Bool {
            if case .reply(let reply) = self { return reply.isExpanded }
            return false
        }
    }

    public var body: Body
    public var outline: BalloonOutline
    public var tail: BalloonTail
    public var tailX: CGFloat
    public var width: CGFloat
    public var textScale: Double
    /// The height of the panel this is drawn in; the box is drawn to it. nil means the height of what it says.
    public var panelHeight: CGFloat?
    public var closeHelp: String

    public init(
        body: Body, outline: BalloonOutline, tail: BalloonTail, tailX: CGFloat, width: CGFloat,
        textScale: Double, panelHeight: CGFloat? = nil, closeHelp: String
    ) {
        self.body = body
        self.outline = outline
        self.tail = tail
        self.tailX = tailX
        self.width = width
        self.textScale = textScale
        self.panelHeight = panelHeight
        self.closeHelp = closeHelp
    }
}

public struct NoticeBundleProps: Equatable, Sendable {
    public var text: String
    /// `text` with its URLs as links (ADR 0038).
    public var runs: [TextRun]
    public var lineLimit: Int
    /// The owner opened this card, so `text` is the whole notice.
    public var isExpanded: Bool
    public var showsHistoryLink: Bool
    public var more: Int
    public var help: String
    /// What the × says it does. It checks the front card only.
    public var closeHelp: String
    public var edges: Int
    /// Cards behind go away from the character: up in the upright column, down when it is flipped.
    public var edgesUpward: Bool
    public var width: CGFloat
    public var textScale: Double
    /// The height of the panel this is drawn in; the card is drawn to it. See `BalloonProps.panelHeight`.
    public var panelHeight: CGFloat?

    public init(
        text: String, runs: [TextRun]? = nil, lineLimit: Int, isExpanded: Bool = false, showsHistoryLink: Bool,
        more: Int, help: String, closeHelp: String, edges: Int, edgesUpward: Bool, width: CGFloat, textScale: Double,
        panelHeight: CGFloat? = nil
    ) {
        self.text = text
        self.runs = runs ?? TextLinks.runs(in: text)
        self.lineLimit = lineLimit
        self.isExpanded = isExpanded
        self.showsHistoryLink = showsHistoryLink
        self.more = more
        self.help = help
        self.closeHelp = closeHelp
        self.edges = edges
        self.edgesUpward = edgesUpward
        self.width = width
        self.textScale = textScale
        self.panelHeight = panelHeight
    }
}

/// A message the owner sent that could not be recorded.
public struct FailureProps: Equatable, Sendable, Identifiable {
    public var requestId: String
    public var text: String

    public init(requestId: String, text: String) {
        self.requestId = requestId
        self.text = text
    }

    public var id: String { requestId }
}

/// The face beside one of her lines in the history: the feeling she put into it (ADR 0026).
public struct FaceProps: Equatable, Sendable {
    /// nil when the feeling is not known. That is not neutral: it is drawn as her neutral face, faded.
    public var expression: Expression?
    /// Her newest line has the larger face.
    public var isLarge: Bool
    public var help: String

    public init(expression: Expression?, isLarge: Bool, help: String) {
        self.expression = expression
        self.isLarge = isLarge
        self.help = help
    }
}

public struct HistoryRowProps: Equatable, Sendable, Identifiable {
    public var messageId: String
    public var text: String
    /// `text` with its URLs as links (ADR 0038).
    public var runs: [TextRun]
    /// When it was said, small beside the row. nil when the server's timestamp cannot be read.
    public var time: String?
    public var isOwner: Bool
    public var isNotice: Bool
    /// An unread reply or a notice not checked yet. A reply is read once its row is seen in the key window.
    public var isUnread: Bool
    /// nil on the owner's messages.
    public var face: FaceProps?
    /// The pictures she attached, small, under the text (ADR 0045).
    public var images: [ImageTileProps]

    public init(
        messageId: String, text: String, time: String?, isOwner: Bool, isNotice: Bool, isUnread: Bool,
        face: FaceProps? = nil, images: [ImageTileProps] = []
    ) {
        self.messageId = messageId
        self.text = text
        self.runs = TextLinks.runs(in: text)
        self.time = time
        self.isOwner = isOwner
        self.isNotice = isNotice
        self.isUnread = isUnread
        self.face = face
        self.images = images
    }

    public var id: String { messageId }
}

public struct OutgoingRowProps: Equatable, Sendable, Identifiable {
    public var requestId: String
    public var text: String
    /// `text` with its URLs as links (ADR 0038).
    public var runs: [TextRun]
    /// nil while it is only waiting to be accepted.
    public var failure: String?

    public init(requestId: String, text: String, failure: String?) {
        self.requestId = requestId
        self.text = text
        self.runs = TextLinks.runs(in: text)
        self.failure = failure
    }

    public var id: String { requestId }
}

/// The whole conversation, unfolded above the input field.
public struct HistoryProps: Equatable, Sendable {
    public var rows: [HistoryRowProps]
    public var outgoing: [OutgoingRowProps]
    public var isThinking: Bool
    /// Where the faces are drawn from.
    public var avatar: AvatarArt

    public init(rows: [HistoryRowProps], outgoing: [OutgoingRowProps], isThinking: Bool, avatar: AvatarArt = .placeholder) {
        self.rows = rows
        self.outgoing = outgoing
        self.isThinking = isThinking
        self.avatar = avatar
    }
}

/// The conversation window (ADR 0021): the input field, and the history when it is unfolded above it.
public struct ConversationProps: Equatable, Sendable {
    /// Where the window is, in screen coordinates. The root puts it there; unfolding and folding are seen happening.
    public var frame: CGRect
    /// The window's height while folded. The input field keeps the height it has then, and the history takes
    /// the rest.
    public var foldedHeight: CGFloat
    /// The window always says where the connection stands, even when it is fine.
    public var status: StatusProps
    /// nil while the history is folded away.
    public var history: HistoryProps?
    /// Messages that could not be recorded, over the input field. While the history is unfolded they are in it.
    public var failures: [FailureProps]
    /// What the button under the title bar does.
    public var toggleHelp: String

    public init(
        frame: CGRect, foldedHeight: CGFloat, status: StatusProps, history: HistoryProps?,
        failures: [FailureProps], toggleHelp: String
    ) {
        self.frame = frame
        self.foldedHeight = foldedHeight
        self.status = status
        self.history = history
        self.failures = failures
        self.toggleHelp = toggleHelp
    }
}

public struct SettingsProps: Equatable, Sendable {
    public var serverOrigin: String
    /// What the last save of the server said.
    public var message: String?
    public var statusText: String
    public var lastError: String?
    public var canLogin: Bool
    public var canLogout: Bool
    public var scale: CharacterScale
    public var avatarDirectory: String
    public var avatarDescription: String
    /// The global shortcut as the menus write it, or "なし".
    public var hotKey: String
    public var isRecordingHotKey: Bool
    public var hotKeyMessage: String?
    public var canClearHotKey: Bool
    public var canResetHotKey: Bool
    public var modelRoutes: ModelRoutesProps

    public init(
        serverOrigin: String, message: String?, statusText: String, lastError: String?, canLogin: Bool,
        canLogout: Bool, scale: CharacterScale, avatarDirectory: String, avatarDescription: String,
        hotKey: String = HotKey.default.displayName, isRecordingHotKey: Bool = false, hotKeyMessage: String? = nil,
        canClearHotKey: Bool = true, canResetHotKey: Bool = false,
        modelRoutes: ModelRoutesProps = ModelRoutesProps(summary: "経路はまだ分かりません", menuTitle: "モデル: 不明")
    ) {
        self.serverOrigin = serverOrigin
        self.message = message
        self.statusText = statusText
        self.lastError = lastError
        self.canLogin = canLogin
        self.canLogout = canLogout
        self.scale = scale
        self.avatarDirectory = avatarDirectory
        self.avatarDescription = avatarDescription
        self.hotKey = hotKey
        self.isRecordingHotKey = isRecordingHotKey
        self.hotKeyMessage = hotKeyMessage
        self.canClearHotKey = canClearHotKey
        self.canResetHotKey = canResetHotKey
        self.modelRoutes = modelRoutes
    }
}

public struct MenuProps: Equatable, Sendable {
    public var statusText: String
    public var canReadAllReplies: Bool
    public var canAcknowledgeAllNotices: Bool
    public var showsLogin: Bool
    public var canLogout: Bool
    public var modelRoutes: ModelRoutesProps

    public init(
        statusText: String, canReadAllReplies: Bool, canAcknowledgeAllNotices: Bool, showsLogin: Bool, canLogout: Bool,
        modelRoutes: ModelRoutesProps = ModelRoutesProps(summary: "経路はまだ分かりません", menuTitle: "モデル: 不明")
    ) {
        self.statusText = statusText
        self.canReadAllReplies = canReadAllReplies
        self.canAcknowledgeAllNotices = canAcknowledgeAllNotices
        self.showsLogin = showsLogin
        self.canLogout = canLogout
        self.modelRoutes = modelRoutes
    }
}

/// Everything the tree draws, in one value. A panel that is not there is nil.
public struct RootProps: Equatable, Sendable {
    public var character: CharacterProps
    public var balloon: BalloonProps?
    public var notices: NoticeBundleProps?
    public var conversation: ConversationProps?
    public var settings: SettingsProps
    public var menu: MenuProps
    public var isSettingsOpen: Bool
    /// The picture opened large, in a window of its own; nil while there is none.
    public var viewer: ImageViewerProps? = nil

    /// The same parameters with the line of thinking taken out: what the column is laid out from. The thought
    /// bubble, and the thinking row under a reply, hold one line at their own width whatever that line says, so a
    /// new line settles nothing and the layout is not worked out again for it (ADR 0017, ADR 0025).
    public var withoutThinkingLine: RootProps {
        var copy = self
        switch balloon?.body {
        case .thinking(var thinking) where thinking.line != nil:
            thinking.line = nil
            copy.balloon?.body = .thinking(thinking)
        case .reply(var reply) where reply.thinking?.line != nil:
            reply.thinking?.line = nil
            copy.balloon?.body = .reply(reply)
        default:
            return self
        }
        return copy
    }
}

/// The drawing parameters, derived from the mediator's state by pure functions. Nothing else in the app may build
/// them.
public enum UIProps {
    /// `time` is when this is drawn, for the history's times.
    public static func root(_ state: UIState, placement: ColumnPlacement, time: MessageTime) -> RootProps {
        var placement = placement
        placement.width = state.columnWidth
        // An opened card takes the room at the sides as well as the room above or below (ADR 0016).
        placement.expandedWidth = OverlayLayout.expandedWidth(placement.width, visible: state.visibleFrame)
        let conversation = state.conversation
        return RootProps(
            character: character(state, stack: noticeStack(conversation)),
            balloon: balloon(
                conversation, dismissed: state.isIndicatorDismissed, readingHistory: state.isReadingHistory,
                expanded: state.expanded, placement: placement, scale: state.characterScale, images: state.images),
            notices: notices(
                conversation, hidden: state.noticesHidden, expanded: state.expanded, placement: placement,
                scale: state.characterScale),
            conversation: state.isConversationOpen ? self.conversation(state, time: time) : nil,
            settings: settings(state),
            menu: menu(state),
            isSettingsOpen: state.isSettingsOpen,
            viewer: viewer(state))
    }

    // MARK: - What the conversation says

    /// The reply the balloon says: her last one, while it is unread (ADR 0022). The read position is one cursor, so
    /// when the last reply is read, every reply is.
    public static func unreadReply(_ conversation: ConversationState) -> ShownMessage? {
        guard let last = conversation.lastReply, conversation.isUnread(last) else { return nil }
        return last
    }

    /// The unchecked notices, oldest in front; nil when there are none.
    public static func noticeStack(_ conversation: ConversationState) -> NoticeStack? {
        let ids = conversation.unacknowledgedNotificationIds
        let byId = Dictionary(conversation.messages.map { ($0.messageId, $0) }, uniquingKeysWith: { first, _ in first })
        // Notices missing from the messages are older than all of them, so they come first.
        let older = ids.prefix { byId[$0] == nil }
        let listed = ids.dropFirst(older.count).compactMap { byId[$0] }
        let cards = (older.isEmpty ? 0 : 1) + listed.count
        if !older.isEmpty {
            return NoticeStack(front: .older(ids: Array(older)), frontIds: Array(older), count: ids.count, cards: cards)
        }
        guard let first = listed.first else { return nil }
        return NoticeStack(front: .notice(first), frontIds: [first.messageId], count: ids.count, cards: cards)
    }

    /// What the balloon says instead of her last reply, while there is something to wait for.
    public static func indicator(_ conversation: ConversationState) -> BalloonIndicator? {
        if conversation.outbox.contains(where: { $0.status == .sending }) { return .receiving }
        return conversation.isThinking ? .thinking : nil
    }

    // MARK: - The panels

    static func character(_ state: UIState, stack: NoticeStack?) -> CharacterProps {
        var badge: BadgeProps?
        if let count = stack?.count, count > 0 {
            let shown = !state.noticesHidden
            badge = BadgeProps(
                count: count, frame: CharacterBadge.frame(for: state.characterScale),
                help: "未確認の知らせ \(count) 件（クリックで\(shown ? "隠す" : "出す")）")
        }
        return CharacterProps(
            scale: state.characterScale, avatar: state.avatar, expression: state.conversation.expression,
            motion: state.motion, disconnectedHelp: state.status == .connected ? nil : state.status.text,
            badge: badge)
    }

    /// The reply the balloon says out loud, if it says one. While natsumi is receiving or handling something, only a
    /// reply she sent during that handling is said; one left from before waits until she has finished, so that the
    /// owner can tell which one answers them (ADR 0017, ADR 0025). While the owner is reading the history, the reply
    /// is left to the window, so that one arriving there does not flash up here before it is read.
    public static func shownReply(_ conversation: ConversationState, readingHistory: Bool) -> ShownMessage? {
        guard !readingHistory, let last = unreadReply(conversation) else { return nil }
        guard indicator(conversation) == nil || conversation.isFromCurrentHandling(last) else { return nil }
        return last
    }

    /// What the balloon says: her last reply while it is unread, one only (ADR 0022), with what she is thinking under
    /// it while she is still handling something (ADR 0025). Otherwise, while she is receiving or handling something,
    /// the thought bubble (ADR 0017).
    public static func balloon(
        _ conversation: ConversationState, dismissed: Bool, readingHistory: Bool = false,
        expanded: ExpandedCard? = nil, placement: ColumnPlacement, scale: CharacterScale, images: ImageShelf = ImageShelf()
    ) -> BalloonProps? {
        func props(
            body: BalloonProps.Body, outline: BalloonOutline, width: CGFloat, closeHelp: String
        ) -> BalloonProps {
            BalloonProps(
                body: body, outline: outline, tail: placement.tail, tailX: placement.tailX,
                width: width, textScale: scale.textScale, panelHeight: placement.balloonHeight,
                closeHelp: closeHelp)
        }
        // The × on the thought bubble closes what she is thinking, not what she says (ADR 0025).
        let thinking = indicator(conversation).flatMap { indicator in
            dismissed
                ? nil
                : ThinkingProps(label: indicator == .receiving ? "受付中" : "考え中", line: conversation.thinkingLine)
        }
        guard let last = shownReply(conversation, readingHistory: readingHistory) else {
            guard let thinking else { return nil }
            return props(
                body: .thinking(thinking), outline: .thought, width: placement.width, closeHelp: "閉じる")
        }
        let isExpanded = expanded == .reply(last.messageId)
        let shown = card(last.text, isExpanded: isExpanded, budget: placement.budget)
        let width = isExpanded ? placement.expandedWidth : placement.width
        let reply = ReplyProps(
            text: shown.text, runs: TextLinks.runs(in: shown.text, isCut: shown.isCut), lineLimit: shown.lineLimit, isExpanded: isExpanded,
            showsHistoryLink: shown.showsHistoryLink, unread: conversation.unreadReplyCount,
            help: isExpanded ? "クリックで畳む" : "クリックで全文を出す", thinking: thinking,
            images: ImageStrip.balloon(width: width, textScale: scale.textScale)
                .tiles(last.images, shelf: images, openHelp: "クリックで拡大"))
        return props(body: .reply(reply), outline: .speech, width: width, closeHelp: "既読にして閉じる")
    }

    /// What a card puts on the screen: the preview, or the whole text when the owner opened it, and whether the
    /// history still has more of it than is shown.
    /// `isCut` says the preview was cut short of the text, so a URL at its end may not be whole.
    static func card(_ text: String, isExpanded: Bool, budget: StackBudget) -> (
        text: String, isCut: Bool, lineLimit: Int, showsHistoryLink: Bool
    ) {
        guard isExpanded else {
            let preview = BalloonText.preview(text)
            let lines = min(budget.lines, BalloonText.maxLines)
            return (preview.text, preview.isTruncated, lines, preview.isTruncated || lines < BalloonText.maxLines)
        }
        let whole = BalloonText.whole(text)
        let lines = budget.lines
        // The column gave less than the whole allowance, or the text is written in more lines than that: what is
        // left over is only in the history.
        let cut = lines < BalloonText.expandedMaxLines || BalloonText.lineCount(whole) > lines
        return (whole, false, lines, cut)
    }

    public static func notices(
        _ conversation: ConversationState, hidden: Bool, expanded: ExpandedCard? = nil, placement: ColumnPlacement,
        scale: CharacterScale
    ) -> NoticeBundleProps? {
        guard !hidden, let stack = noticeStack(conversation) else { return nil }
        let text: String
        let runs: [TextRun]
        let lineLimit: Int
        let showsHistoryLink: Bool
        let isExpanded: Bool
        let help: String
        let closeHelp: String
        switch stack.front {
        case .notice(let message):
            isExpanded = expanded == .notice(message.messageId)
            let shown = card(message.text, isExpanded: isExpanded, budget: placement.budget)
            text = shown.text
            runs = TextLinks.runs(in: shown.text, isCut: shown.isCut)
            lineLimit = shown.lineLimit
            showsHistoryLink = shown.showsHistoryLink
            help = isExpanded ? "クリックで畳む" : "クリックで全文を出す"
            closeHelp = stack.more > 0 ? "この知らせを確認して次へ" : "この知らせを確認して閉じる"
        case .older(let ids):
            // Their text is older than the history, so there is nothing to open and nowhere to send the owner.
            isExpanded = false
            text = "前の知らせが \(ids.count) 件あります（本文は履歴より前のため出せません）"
            runs = [.plain(text)]
            lineLimit = min(placement.budget.lines, BalloonText.maxLines)
            showsHistoryLink = false
            help = "クリックでまとめて確かめる"
            closeHelp = stack.more > 0 ? "まとめて確認して次へ" : "まとめて確認して閉じる"
        }
        return NoticeBundleProps(
            text: text, runs: runs, lineLimit: lineLimit, isExpanded: isExpanded, showsHistoryLink: showsHistoryLink,
            more: stack.more, help: help, closeHelp: closeHelp,
            edges: min(stack.behind, placement.budget.behind), edgesUpward: placement.tail == .down,
            width: isExpanded ? placement.expandedWidth : placement.width, textScale: scale.textScale,
            panelHeight: placement.noticesHeight)
    }

    /// The ladder the column is laid out with. An opened card asks for many more lines than a closed one.
    public static func budgetSteps(_ state: UIState) -> [StackBudget] {
        state.expanded == nil ? StackBudget.steps : StackBudget.expandedSteps
    }

    /// The conversation window. It has been placed by the time it is drawn: opening it gives it its first place.
    public static func conversation(_ state: UIState, time: MessageTime) -> ConversationProps {
        let window = state.conversationWindow
        let conversation = state.conversation
        return ConversationProps(
            frame: window.frame ?? CGRect(origin: .zero, size: window.size), foldedHeight: window.foldedHeight,
            status: statusRow(state.status),
            history: window.showsHistory
                ? history(
                    conversation, time: time, avatar: state.avatar, images: state.images,
                    strip: .macHistory(windowWidth: window.size.width))
                : nil,
            failures: window.showsHistory ? [] : failures(conversation),
            toggleHelp: window.showsHistory ? "履歴をとじる（⌘L）" : "履歴をひらく（⌘L）")
    }

    /// The messages that could not be recorded, as the folded window lists them over the input field.
    public static func failures(_ conversation: ConversationState) -> [FailureProps] {
        conversation.outbox.compactMap { item in
            switch item.status {
            case .sending: nil
            case .rejected(let code), .unavailable(let code):
                FailureProps(requestId: item.requestId, text: "「\(item.text)」を送れませんでした（\(code)）")
            }
        }
    }

    public static func history(
        _ conversation: ConversationState, time: MessageTime, avatar: AvatarArt = .placeholder,
        images: ImageShelf = ImageShelf(), strip: ImageStrip = .macHistory(windowWidth: ConversationWindow.default.size.width),
        openHelp: String = "クリックで拡大"
    ) -> HistoryProps {
        let times = time.labels(conversation.messages.map(\.date))
        let unread = conversation.unreadFlags
        let newest = conversation.messages.lastIndex { $0.role == .natsumi }
        return HistoryProps(
            rows: conversation.messages.indices.map { index in
                let message = conversation.messages[index]
                let face = message.role == .owner ? nil : FaceProps(
                    expression: message.expression, isLarge: index == newest, help: feelingHelp(message.expression))
                return HistoryRowProps(
                    messageId: message.messageId, text: message.text, time: times[index],
                    isOwner: message.role == .owner, isNotice: message.isNotice, isUnread: unread[index], face: face,
                    images: message.images.isEmpty ? [] : strip.tiles(message.images, shelf: images, openHelp: openHelp))
            },
            outgoing: conversation.outbox.map { item in
                let failure: String? = switch item.status {
                case .sending: nil
                case .rejected(let code), .unavailable(let code): "送れませんでした（\(code)）"
                }
                return OutgoingRowProps(requestId: item.requestId, text: item.text, failure: failure)
            },
            isThinking: conversation.isThinking, avatar: avatar)
    }

    /// The picture opened large, while it is here to show.
    static func viewer(_ state: UIState) -> ImageViewerProps? {
        guard let id = state.viewedImage, case .loaded(let image) = state.images[id] else { return nil }
        return ImageViewerProps(image: image, title: "なつみの画像")
    }

    /// What the face says when the pointer rests on it.
    static func feelingHelp(_ expression: Expression?) -> String {
        guard let expression else { return "気持ちの記録なし" }
        let name = switch expression {
        case .neutral: "ふつう"
        case .happy: "うれしい"
        case .laughing: "楽しい"
        case .surprised: "びっくり"
        case .thinking: "考え中"
        case .worried: "心配"
        case .sad: "かなしい"
        case .sleepy: "ねむい"
        }
        return "気持ち: \(name)"
    }

    static func settings(_ state: UIState) -> SettingsProps {
        SettingsProps(
            serverOrigin: state.serverOrigin ?? "", message: state.settingsMessage, statusText: state.status.text,
            lastError: state.lastError, canLogin: state.status == .needsLogin, canLogout: state.hasSession,
            scale: state.characterScale, avatarDirectory: state.avatarDirectory,
            avatarDescription: state.avatarDescription,
            hotKey: state.hotKey?.displayName ?? "なし", isRecordingHotKey: state.isRecordingHotKey,
            hotKeyMessage: state.hotKeyMessage, canClearHotKey: state.hotKey != nil,
            canResetHotKey: state.hotKey != .default,
            modelRoutes: modelRoutes(state.session.modelRoutes, isConnected: state.status == .connected))
    }

    static func menu(_ state: UIState) -> MenuProps {
        MenuProps(
            statusText: state.status.text, canReadAllReplies: !state.conversation.unreadReplies.isEmpty,
            canAcknowledgeAllNotices: !state.conversation.unacknowledgedNotificationIds.isEmpty,
            showsLogin: state.status == .needsLogin, canLogout: state.hasSession,
            modelRoutes: modelRoutes(state.session.modelRoutes, isConnected: state.status == .connected))
    }

    /// The connection and what to do about it. The window says where it stands either way (ADR 0021).
    static func statusRow(_ status: ConnectionStatus) -> StatusProps {
        StatusProps(text: status.text, action: action(for: status))
    }

    /// The one thing the owner can do about the connection as it is.
    private static func action(for status: ConnectionStatus) -> ActionProps? {
        switch status {
        case .needsServer: ActionProps(title: "設定を開く", event: .settingsOpenRequested)
        case .needsLogin: ActionProps(title: "GitHub でログイン", event: .loginRequested)
        case .replaced, .stopped, .unavailable: ActionProps(title: "接続し直す", event: .reconnectRequested)
        default: nil
        }
    }
}

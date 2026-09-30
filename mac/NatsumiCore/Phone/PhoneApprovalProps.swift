import Foundation

/// The way into the approvals from the main screen: how many are waiting.
public struct PhoneApprovalEntryProps: Equatable, Sendable {
    /// 「承認待ち N 件」.
    public var text: String

    public init(text: String) {
        self.text = text
    }
}

/// One approval in the list.
public struct PhoneApprovalRowProps: Equatable, Identifiable, Sendable {
    public var approvalId: String
    public var channel: String
    /// The first line of the draft.
    public var text: String
    /// Why it came to the owner, in a few words.
    public var reason: String
    /// When it was made; nil when the server's time cannot be read.
    public var time: String?
    /// The owner's decision on its way, when there is one.
    public var status: String?

    public init(approvalId: String, channel: String, text: String, reason: String, time: String?, status: String?) {
        self.approvalId = approvalId
        self.channel = channel
        self.text = text
        self.reason = reason
        self.time = time
        self.status = status
    }

    public var id: String { approvalId }
}

/// The approvals waiting for the owner, oldest first.
public struct PhoneApprovalListProps: Equatable, Sendable {
    public var rows: [PhoneApprovalRowProps]

    public init(rows: [PhoneApprovalRowProps]) {
        self.rows = rows
    }
}

/// The line the post answers.
public struct PhoneReplyTargetProps: Equatable, Sendable {
    public var speaker: String
    public var at: String
    public var text: String

    public init(speaker: String, at: String, text: String) {
        self.speaker = speaker
        self.at = at
        self.text = text
    }
}

/// One of the places the post can go: the thread, the channel, or both.
public struct PhonePlacementOptionProps: Equatable, Identifiable, Sendable {
    public var title: String
    public var placement: ApprovalPlacement
    public var isSelected: Bool

    public init(title: String, placement: ApprovalPlacement, isSelected: Bool) {
        self.title = title
        self.placement = placement
        self.isSelected = isSelected
    }

    public var id: String { placement.rawValue }
}

/// One of the judge's issues with the draft.
public struct PhoneIssueProps: Equatable, Identifiable, Sendable {
    public var name: String
    public var label: String
    /// From 0 to 1, for the bar.
    public var score: Double
    /// 「82%」.
    public var percent: String
    /// Over the threshold: drawn to stand out.
    public var flagged: Bool

    public init(name: String, label: String, score: Double, percent: String, flagged: Bool) {
        self.name = name
        self.label = label
        self.score = score
        self.percent = percent
        self.flagged = flagged
    }

    public var id: String { name }
}

/// A draft for the same line that was sent back before.
public struct PhonePastDraftProps: Equatable, Identifiable, Sendable {
    public var index: Int
    /// 「1 回目の下書き」.
    public var title: String
    public var text: String
    /// The issues flagged then, joined; nil when none were.
    public var flagged: String?

    public init(index: Int, title: String, text: String, flagged: String?) {
        self.index = index
        self.title = title
        self.text = text
        self.flagged = flagged
    }

    public var id: Int { index }
}

/// What the owner can do with the approval now.
public enum PhoneApprovalControls: Equatable, Sendable {
    /// 承認・修正・却下.
    case choose
    /// The draft is a text field starting with this text, with 「修正して送る」 and 「やめる」.
    case editing(draft: String)
    /// A decision is on its way: this says where it is, and nothing can be chosen.
    case waiting(String)
    /// It is closed.
    case closed
}

/// What came of an approval that closed.
public struct PhoneApprovalResultProps: Equatable, Sendable {
    public var title: String
    /// Why it could not be sent.
    public var detail: String?
    /// The text that was sent.
    public var sentText: String?
    public var isFailure: Bool

    public init(title: String, detail: String?, sentText: String?, isFailure: Bool) {
        self.title = title
        self.detail = detail
        self.sentText = sentText
        self.isFailure = isFailure
    }
}

/// One approval, whole.
public struct PhoneApprovalDetailProps: Equatable, Sendable {
    public var approvalId: String
    public var channel: String
    /// nil for a post to the channel itself.
    public var replyTo: PhoneReplyTargetProps?
    /// Where the post goes, as the owner has it now.
    public var placement: String
    /// The choice of the thread, the channel or both; empty when there is none to make.
    public var placementOptions: [PhonePlacementOptionProps]
    /// How likely the judge found each place, when it said.
    public var placementOdds: String?
    public var text: String
    /// The face on the post's icon, when there is one.
    public var face: Expression?
    public var avatar: AvatarArt
    /// Why it came to the owner.
    public var reason: String
    public var issues: [PhoneIssueProps]
    public var history: [PhonePastDraftProps]
    public var created: String?
    public var expires: String?
    public var controls: PhoneApprovalControls
    /// Why the last decision was refused.
    public var message: String?
    public var result: PhoneApprovalResultProps?
    /// The pictures that go with the post, small, while it waits (ADR 0044). They are let go of when it closes.
    public var images: [ImageTileProps]
    /// What stands in for the pictures of a closed approval.
    public var imagesNote: String?

    public init(
        approvalId: String, channel: String, replyTo: PhoneReplyTargetProps?, placement: String,
        placementOptions: [PhonePlacementOptionProps], placementOdds: String?, text: String, face: Expression?,
        avatar: AvatarArt, reason: String, issues: [PhoneIssueProps], history: [PhonePastDraftProps], created: String?,
        expires: String?, controls: PhoneApprovalControls, message: String?, result: PhoneApprovalResultProps?,
        images: [ImageTileProps] = [], imagesNote: String? = nil
    ) {
        self.approvalId = approvalId
        self.channel = channel
        self.replyTo = replyTo
        self.placement = placement
        self.placementOptions = placementOptions
        self.placementOdds = placementOdds
        self.text = text
        self.face = face
        self.avatar = avatar
        self.reason = reason
        self.issues = issues
        self.history = history
        self.created = created
        self.expires = expires
        self.controls = controls
        self.message = message
        self.result = result
        self.images = images
        self.imagesNote = imagesNote
    }
}

/// The page of one approval: the approval, or why there is none to show.
public enum PhoneApprovalPageProps: Equatable, Sendable {
    case detail(PhoneApprovalDetailProps)
    case missing(String)
}

/// The approval screens' drawing parameters, derived from the mediator's state.
enum PhoneApprovalProps {
    static func entry(_ state: PhoneState) -> PhoneApprovalEntryProps? {
        let count = state.approvals.pending.count
        guard count > 0, !state.isComposing else { return nil }
        return PhoneApprovalEntryProps(text: "承認待ち \(count) 件")
    }

    static func list(_ state: PhoneState, time: MessageTime) -> PhoneApprovalListProps {
        let book = state.approvals
        let times = time.labels(book.pending.map(\.createdAt))
        return PhoneApprovalListProps(rows: zip(book.pending, times).map { approval, at in
            let status: String? = switch book.decisions[approval.approvalId]?.status {
            case .sending: "送っています…"
            case .accepted: "受け付けました"
            case .failed: "送れませんでした"
            case nil: nil
            }
            return PhoneApprovalRowProps(
                approvalId: approval.approvalId, channel: approval.target.channel,
                text: String(approval.text.prefix { $0 != "\n" }), reason: shortReason(approval.reason.verdict),
                time: at, status: status)
        })
    }

    static func page(_ state: PhoneState, id: String, time: MessageTime) -> PhoneApprovalPageProps {
        let book = state.approvals
        guard let approval = book.approval(id) else {
            return .missing(state.status == .connected
                ? "この承認は見つかりません。もう閉じたのかもしれません" : "承認を読み込んでいます…")
        }
        let isPending = book.pending.contains { $0.approvalId == id }
        let decision = book.decisions[id]
        let canMove = isPending && approval.target.replyTo != nil
        // What the owner chose here stays after it closes: that is where it was sent. A place this app does not know
        // stays unknown until the owner chooses one.
        let placement = (approval.target.replyTo != nil ? state.approvalPlacement : nil) ?? approval.target.placement
            ?? (approval.target.replyTo == nil ? .channel : nil)
        let dates = time.labels([approval.createdAt, approval.expiresAt])

        let controls: PhoneApprovalControls = if !isPending {
            .closed
        } else {
            switch decision?.status {
            case .sending: .waiting("送っています…")
            case .accepted: .waiting("受け付けました。送った結果を待っています…")
            case .failed, nil: state.isEditingApproval ? .editing(draft: approval.text) : .choose
            }
        }
        let message: String? = if case .failed(let code) = decision?.status {
            code == "stale-revision" ? "中身が新しくなっていました。見直してから、もう一度選んでください" : "送れませんでした（\(code)）"
        } else {
            nil
        }

        return .detail(PhoneApprovalDetailProps(
            approvalId: id, channel: approval.target.channel,
            replyTo: approval.target.replyTo.map { PhoneReplyTargetProps(speaker: $0.speaker, at: $0.at, text: $0.text) },
            placement: placement.map(description) ?? "置き場所は不明",
            placementOptions: canMove
                ? ApprovalPlacement.allCases.map {
                    PhonePlacementOptionProps(title: title($0), placement: $0, isSelected: $0 == placement)
                }
                : [],
            placementOdds: approval.reason.placementOdds.map { odds in
                "判定の見立て: " + ApprovalPlacement.allCases.compactMap { place in
                    odds[place].map { "\(title(place)) \(percent($0))" }
                }.joined(separator: "・")
            },
            text: approval.text, face: approval.expression, avatar: state.avatar, reason: reason(approval.reason.verdict),
            issues: approval.reason.issues.map {
                PhoneIssueProps(name: $0.name, label: $0.label, score: $0.score, percent: percent($0.score), flagged: $0.flagged)
            },
            history: approval.history.enumerated().map { index, draft in
                let flagged = draft.issues.filter(\.flagged).map(\.label)
                return PhonePastDraftProps(
                    index: index, title: "\(index + 1) 回目の下書き", text: draft.text,
                    flagged: flagged.isEmpty ? nil : flagged.joined(separator: "・"))
            },
            created: dates[0], expires: dates[1].map { "期限 \($0)" }, controls: controls, message: message,
            result: book.closed[id].map { result($0.resolution) },
            images: isPending ? ImageStrip.phoneApproval.tiles(approval.images, shelf: state.images, openHelp: "タップで拡大") : [],
            imagesNote: isPending || approval.images.isEmpty
                ? nil : "画像 \(approval.images.count) 枚（承認が閉じたので表示しません）"))
    }

    /// Where the post goes, in a few words.
    static func description(_ placement: ApprovalPlacement) -> String {
        switch placement {
        case .thread: "スレッドに返す"
        case .channel: "チャンネルに投稿"
        case .broadcast: "スレッドに返し、チャンネルにも表示"
        }
    }

    /// The place's name on its button and in the judge's odds.
    static func title(_ placement: ApprovalPlacement) -> String {
        switch placement {
        case .thread: "スレッド"
        case .channel: "チャンネル"
        case .broadcast: "チャンネルにも"
        }
    }

    static func reason(_ verdict: ApprovalVerdict?) -> String {
        switch verdict {
        case .owner: "判定が「本人に回す」になりました"
        case .noVerdict: "判定がありませんでした"
        case .rewriteLimit: "同じ返信先で 3 回目の突き返しになりました"
        case nil: "本人の確認が要ります"
        }
    }

    static func shortReason(_ verdict: ApprovalVerdict?) -> String {
        switch verdict {
        case .owner: "判定で回った"
        case .noVerdict: "判定なし"
        case .rewriteLimit: "3 回目の突き返し"
        case nil: "確認が要る"
        }
    }

    static func result(_ resolution: ApprovalResolution) -> PhoneApprovalResultProps {
        let verb: String
        switch resolution.outcome {
        case .approved: verb = "承認"
        case .edited: verb = "修正"
        case .rejected: return PhoneApprovalResultProps(title: "却下しました", detail: nil, sentText: nil, isFailure: false)
        case .expired: return PhoneApprovalResultProps(title: "期限が切れました", detail: nil, sentText: nil, isFailure: false)
        case nil: return PhoneApprovalResultProps(title: "閉じました", detail: nil, sentText: nil, isFailure: false)
        }
        switch resolution.delivery {
        case .sent:
            return PhoneApprovalResultProps(title: "\(verb)して送りました", detail: nil, sentText: resolution.sentText, isFailure: false)
        case .failed(let reason):
            let detail: String? = switch reason {
            case "mechanical-check": "送る前の検査に当たったので、送っていません"
            case "slack-error": "Slack が受け付けませんでした"
            case "target-gone": "返信先が見つかりませんでした"
            case let other?: "送れませんでした（\(other)）"
            case nil: nil
            }
            return PhoneApprovalResultProps(title: "\(verb)しましたが、送れませんでした", detail: detail, sentText: nil, isFailure: true)
        case nil:
            return PhoneApprovalResultProps(title: "\(verb)しました", detail: nil, sentText: resolution.sentText, isFailure: false)
        }
    }

    private static func percent(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }
}

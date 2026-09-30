import NatsumiCore
import SwiftUI

/// How many approvals are waiting, under the status on the main screen.
struct ApprovalEntryView: View {
    let props: PhoneApprovalEntryProps

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 16, weight: .bold))
            Text(props.text)
                .font(Comic.font(14, bold: true))
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .bold))
        }
        .foregroundStyle(Comic.ink)
        .padding(.horizontal, 16)
        .frame(minHeight: 44)
        .background { InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.send) }
        .accessibilityElement(children: .combine)
    }
}

/// The approvals waiting for the owner, oldest first.
struct ApprovalListView: View {
    let props: PhoneApprovalListProps
    let send: PhoneEventSink

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if props.rows.isEmpty {
                    Text("承認待ちはありません")
                        .font(Comic.font(14))
                        .foregroundStyle(Comic.pageFaint)
                        .padding(.top, 40)
                }
                ForEach(props.rows) { row in
                    Button { send(.approvalOpenRequested(approvalId: row.approvalId)) } label: {
                        ApprovalRowView(props: row)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
        .foregroundStyle(Comic.pageInk)
        .background(Comic.page)
        .navigationTitle("承認待ち")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Comic.page, for: .navigationBar)
    }
}

struct ApprovalRowView: View {
    let props: PhoneApprovalRowProps

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(props.channel).font(Comic.font(13, bold: true))
                Spacer()
                if let time = props.time {
                    Text(time).font(Comic.font(12)).foregroundStyle(Comic.pageFaint)
                }
            }
            Text(props.text)
                .font(Comic.font(15))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Text(props.reason)
                if let status = props.status {
                    Text("· \(status)")
                }
            }
            .font(Comic.font(12))
            .foregroundStyle(Comic.pageFaint)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background { InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.surface, ink: Comic.pageInk) }
        .contentShape(Rectangle())
    }
}

/// One approval: where the post goes, the draft, why it came to the owner, and what they can do with it.
struct ApprovalView: View {
    let props: PhoneApprovalPageProps
    let sinks: ScreenSinks

    var body: some View {
        Group {
            switch props {
            case .detail(let detail):
                ApprovalDetailView(props: detail, sinks: sinks)
            case .missing(let text):
                Text(text)
                    .font(Comic.font(14))
                    .foregroundStyle(Comic.pageFaint)
                    .multilineTextAlignment(.center)
                    .padding(32)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .foregroundStyle(Comic.pageInk)
        .background(Comic.page)
        .navigationTitle("承認")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Comic.page, for: .navigationBar)
    }
}

struct ApprovalDetailView: View {
    let props: PhoneApprovalDetailProps
    let sinks: ScreenSinks

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if let result = props.result {
                        ApprovalResultView(props: result)
                            .id(Self.result)
                    }
                    section("返信先") { target }
                    section("下書き") { draft }
                    if !props.images.isEmpty || props.imagesNote != nil {
                        section("一緒に送る画像") { images }
                    }
                    section("本人に回った理由") { reason }
                    if !props.history.isEmpty {
                        section("前の突き返し") {
                            VStack(alignment: .leading, spacing: 12) {
                                ForEach(props.history) { PastDraftView(props: $0) }
                            }
                            .padding(16)
                        }
                    }
                    HStack(spacing: 12) {
                        if let created = props.created { Text("作成 \(created)") }
                        if let expires = props.expires { Text(expires) }
                    }
                    .font(Comic.font(12))
                    .foregroundStyle(Comic.pageFaint)
                    .padding(.leading, 6)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)
            }
            // What came of it is at the top, and the owner is likely further down, where the buttons were.
            .onChange(of: props.result) {
                withAnimation { scroller.scrollTo(Self.result, anchor: .top) }
            }
            }
            controls
        }
    }

    private static let result = "result"

    private var target: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(props.channel).font(Comic.font(15, bold: true))
            if let replyTo = props.replyTo {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(replyTo.speaker) · \(replyTo.at)")
                        .font(Comic.font(12))
                        .foregroundStyle(Comic.pageFaint)
                    Text(replyTo.text).font(Comic.font(14))
                }
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(Comic.floor).frame(width: 3) }
            }
            Text(props.placement).font(Comic.font(14))
            if !props.placementOptions.isEmpty {
                // Three choices do not fit beside the words, so they have a row of their own.
                HStack(spacing: 8) {
                    ForEach(props.placementOptions) { option in
                        Button { sinks.approvalPlacement(.approvalPlacementChosen(option.placement)) } label: {
                            Text(option.title)
                                .font(Comic.font(13, bold: option.isSelected))
                                .foregroundStyle(option.isSelected ? Comic.ink : Comic.pageInk)
                                .padding(.horizontal, 12)
                                .frame(minHeight: 36)
                                .background {
                                    InkedPaper(
                                        shape: Capsule(), fill: option.isSelected ? Comic.send : Comic.surface,
                                        ink: option.isSelected ? Comic.ink : Comic.pageInk, line: 2)
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(option.isSelected ? .isSelected : [])
                    }
                }
            }
            if let odds = props.placementOdds {
                Text(odds).font(Comic.font(12)).foregroundStyle(Comic.pageFaint)
            }
        }
        .padding(16)
    }

    private var draft: some View {
        HStack(alignment: .top, spacing: 10) {
            if let face = props.face {
                FaceView(avatar: props.avatar, expression: face, size: 40)
            }
            if case .editing(let text) = props.controls {
                ApprovalEditor(approvalId: props.approvalId, draft: text, send: sinks.approvalEditor)
                    .id(props.approvalId)
            } else {
                Text(props.text)
                    .font(Comic.font(15))
                    .lineSpacing(6)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
    }

    /// The pictures that go with the post while it waits, or how many there were once it has closed.
    @ViewBuilder
    private var images: some View {
        Group {
            if let note = props.imagesNote {
                Text(note).font(Comic.font(13)).foregroundStyle(Comic.pageFaint)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    ImageStripView(tiles: props.images, spacing: 8) { sinks.approvalImages(.imageTapped(imageId: $0)) }
                }
            }
        }
        .padding(16)
    }

    private var reason: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(props.reason).font(Comic.font(14))
            ForEach(props.issues) { IssueView(props: $0) }
        }
        .padding(16)
    }

    @ViewBuilder
    private var controls: some View {
        VStack(spacing: 8) {
            if let message = props.message {
                Text(message)
                    .font(Comic.font(13))
                    .foregroundStyle(Comic.trouble)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            switch props.controls {
            case .choose:
                HStack(spacing: 10) {
                    actionButton("却下", fill: Comic.surface, ink: Comic.trouble) {
                        sinks.approvalActions(.approvalRejected(approvalId: props.approvalId))
                    }
                    actionButton("修正", fill: Comic.surface, ink: Comic.pageInk) {
                        sinks.approvalActions(.approvalEditRequested)
                    }
                    actionButton("承認して送る", fill: Comic.send, ink: Comic.ink) {
                        sinks.approvalActions(.approvalApproved(approvalId: props.approvalId))
                    }
                }
            case .editing:
                // The field's own buttons are with the field, where its text is.
                EmptyView()
            case .waiting(let text):
                HStack(spacing: 8) {
                    ProgressView()
                    Text(text).font(Comic.font(14))
                }
                .frame(maxWidth: .infinity, minHeight: 52)
            case .closed:
                EmptyView()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, props.controls == .closed && props.message == nil ? 0 : 10)
    }

    private func actionButton(_ title: String, fill: Color, ink: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Comic.font(15, bold: true))
                .foregroundStyle(ink)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background { InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: fill, ink: Comic.pageInk) }
        }
        .buttonStyle(.plain)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(Comic.font(13, bold: true))
                .foregroundStyle(Comic.pageFaint)
                .padding(.leading, 6)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.surface, ink: Comic.pageInk)
                }
        }
    }
}

/// The draft as a text field, with 「修正して送る」 and 「やめる」.
struct ApprovalEditor: View {
    /// What the owner is writing. Like the input field's draft, it belongs to the field until it is sent: the input
    /// method keeps what it is converting on its own side.
    @State private var text: String
    let approvalId: String
    let send: PhoneEventSink

    init(approvalId: String, draft: String, send: PhoneEventSink) {
        self.approvalId = approvalId
        self.send = send
        _text = State(initialValue: draft)
    }

    var body: some View {
        let isEmpty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .trailing, spacing: 10) {
            TextField("送る本文", text: $text, axis: .vertical)
                .accessibilityIdentifier("approval.editor.text")
                .font(Comic.font(15))
                .lineLimit(3...12)
                .padding(10)
                .background {
                    RoundedRectangle(cornerRadius: 10).stroke(Comic.notice, lineWidth: 3)
                }
            HStack(spacing: 10) {
                Button("やめる") { send(.approvalEditCancelled) }
                    .font(Comic.font(14))
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                Button {
                    send(.approvalEditSubmitted(approvalId: approvalId, text: text))
                } label: {
                    Text("修正して送る")
                        .font(Comic.font(14, bold: true))
                        .foregroundStyle(isEmpty ? Comic.disabledInk : Comic.ink)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background {
                            InkedPaper(
                                shape: Capsule(), fill: isEmpty ? Comic.disabled : Comic.send,
                                ink: isEmpty ? Comic.disabledInk : Comic.ink)
                        }
                }
                .buttonStyle(.plain)
                .disabled(isEmpty)
            }
        }
    }
}

/// One of the judge's issues: its name, a bar for its score, and the score. A flagged one stands out.
struct IssueView: View {
    let props: PhoneIssueProps

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if props.flagged {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 12, weight: .bold))
                }
                Text(props.label).font(Comic.font(13, bold: props.flagged))
                Spacer(minLength: 8)
                Text(props.percent).font(Comic.font(12, bold: props.flagged))
            }
            .foregroundStyle(props.flagged ? Comic.trouble : Comic.pageInk)
            GeometryReader { room in
                ZStack(alignment: .leading) {
                    Capsule().fill(Comic.floor)
                    Capsule()
                        .fill(props.flagged ? Comic.trouble : Comic.pageFaint)
                        .frame(width: room.size.width * min(1, max(0, props.score)))
                }
            }
            .frame(height: 6)
        }
        .accessibilityElement(children: .combine)
    }
}

struct PastDraftView: View {
    let props: PhonePastDraftProps

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(props.title).font(Comic.font(12, bold: true)).foregroundStyle(Comic.pageFaint)
            Text(props.text).font(Comic.font(14))
            if let flagged = props.flagged {
                Text(flagged).font(Comic.font(12)).foregroundStyle(Comic.trouble)
            }
        }
    }
}

/// What came of an approval that closed.
struct ApprovalResultView: View {
    let props: PhoneApprovalResultProps

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: props.isFailure ? "xmark.octagon.fill" : "checkmark.circle.fill")
                    .foregroundStyle(props.isFailure ? Comic.trouble : Comic.connected)
                Text(props.title).font(Comic.font(15, bold: true))
            }
            if let detail = props.detail {
                Text(detail).font(Comic.font(13))
            }
            if let sentText = props.sentText {
                Text(sentText)
                    .font(Comic.font(14))
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Comic.floor).frame(width: 3) }
            }
        }
        .foregroundStyle(Comic.ink)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background { InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.notice) }
    }
}

import NatsumiCore
import SwiftUI

/// The whole conversation, newest at the bottom, with her face beside each of her lines (ADR 0027) and the input
/// field under it. What comes into sight here is read and checked (ADR 0028).
struct HistoryView: View {
    let props: PhoneHistoryProps
    let sinks: ScreenSinks

    private static let bottom = "bottom"

    var body: some View {
        let history = props.history
        VStack(spacing: 0) {
            ScrollViewReader { scroller in
            ScrollView {
                // Not lazy: a lazy stack guesses the heights of rows it has not drawn, and then opens short of the
                // bottom. A row is in sight when half of it is on the screen, not when it is merely drawn.
                VStack(spacing: 14) {
                    ForEach(history.rows) { row in
                        HistoryRowView(props: row, avatar: history.avatar) {
                            sinks.historyImages(.imageTapped(imageId: $0))
                        }
                            .onScrollVisibilityChange(threshold: 0.5) { isVisible in
                                sinks.historyRows(.historyRowVisibilityChanged(messageId: row.messageId, isVisible: isVisible))
                            }
                    }
                    ForEach(history.outgoing) { item in
                        OutgoingRowView(props: item, send: sinks.historyOutgoing)
                    }
                    if history.isThinking {
                        HStack(spacing: 8) {
                            FaceView(avatar: history.avatar, expression: .thinking, size: 40)
                            Text("考え中…")
                                .font(Comic.font(13))
                                .foregroundStyle(Comic.pageFaint)
                            Spacer(minLength: 0)
                        }
                    }
                    Color.clear.frame(height: 0).id(Self.bottom)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 16)
            }
            .defaultScrollAnchor(.bottom)
            // It opens at the newest line and goes to each line that arrives. The room it has changes as the keyboard
            // comes and goes (it is often still up from the main screen when this opens), and the newest line is
            // kept in sight through that too.
            .onScrollGeometryChange(for: CGFloat.self, of: { $0.containerSize.height }) { _, _ in
                scroller.scrollTo(Self.bottom, anchor: .bottom)
            }
            .onChange(of: history.rows.count + history.outgoing.count) {
                withAnimation { scroller.scrollTo(Self.bottom, anchor: .bottom) }
            }
            }
            .overlay(alignment: .bottom) { Rectangle().fill(Comic.pageInk).frame(height: 2) }
            InputBar(send: sinks.historyInput)
        }
        .foregroundStyle(Comic.pageInk)
        .background(Comic.page)
        .navigationTitle("会話")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Comic.page, for: .navigationBar)
        .opensLinks(through: sinks.historyRows, as: PhoneEvent.linkTapped)
    }
}

/// One line of the history: hers on the left with her face, the owner's on the right in ink.
struct HistoryRowView: View {
    let props: HistoryRowProps
    let avatar: AvatarArt
    /// A small picture in the row was tapped.
    let openImage: (String) -> Void

    var body: some View {
        if let face = props.face {
            HStack(alignment: .bottom, spacing: 8) {
                FaceView(avatar: avatar, expression: face.expression ?? .neutral, size: face.isLarge ? 72 : 40)
                    // A feeling that is not known is her neutral face, faded (ADR 0027).
                    .opacity(face.expression == nil ? 0.4 : 1)
                    .accessibilityLabel(face.help)
                    .padding(.bottom, 20)
                VStack(alignment: .leading, spacing: 4) {
                    VStack(alignment: .leading, spacing: 4) {
                        if props.isNotice {
                            Text("お知らせ").font(Comic.font(11, bold: true))
                        }
                        Text(AttributedString(runs: props.runs))
                            .font(Comic.font(15))
                            .lineSpacing(6)
                            .textSelection(.enabled)
                        // The pictures she attached, small, at sizes fixed before they come (ADR 0045).
                        if !props.images.isEmpty {
                            ImageStripView(tiles: props.images, spacing: 6, open: openImage)
                                .padding(.top, 4)
                        }
                    }
                    .foregroundStyle(Comic.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background {
                        InkedPaper(
                            shape: UnevenRoundedRectangle(
                                topLeadingRadius: 14, bottomLeadingRadius: 4, bottomTrailingRadius: 14,
                                topTrailingRadius: 14),
                            fill: props.isNotice ? Comic.notice : Comic.paper)
                    }
                    caption((props.speaker ?? "") + (props.time.map { " · \($0)" } ?? ""))
                }
                Spacer(minLength: 24)
            }
        } else {
            VStack(alignment: .trailing, spacing: 4) {
                OwnerBubble(runs: props.runs)
                if let time = props.time { caption(time) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 60)
        }
    }

    private func caption(_ text: String) -> some View {
        HStack(spacing: 6) {
            Text(text)
            if props.isUnread {
                Text(props.isNotice ? "未確認" : "未読")
                    .font(Comic.font(10, bold: true))
                    .foregroundStyle(Comic.ink)
                    .padding(.horizontal, 5)
                    .background(Capsule().fill(Comic.send))
            }
        }
        .font(Comic.font(11))
        .foregroundStyle(Comic.pageFaint)
    }
}

/// What the owner said, in ink on the right.
struct OwnerBubble: View {
    let runs: [TextRun]

    var body: some View {
        Text(AttributedString(runs: runs))
            .font(Comic.font(15))
            .lineSpacing(6)
            .foregroundStyle(Comic.paper)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background {
                InkedPaper(
                    shape: UnevenRoundedRectangle(
                        topLeadingRadius: 14, bottomLeadingRadius: 14, bottomTrailingRadius: 4, topTrailingRadius: 14),
                    fill: Comic.ink, ink: Comic.pageInk)
            }
            .textSelection(.enabled)
    }
}

/// A message the server has not recorded yet: 「受付中…」 under it, or why it failed and its ×.
struct OutgoingRowView: View {
    let props: OutgoingRowProps
    let send: PhoneEventSink

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            OwnerBubble(runs: props.runs)
            if let failure = props.failure {
                HStack(spacing: 4) {
                    Text(failure)
                    Button { send(.outgoingDismissed(requestId: props.requestId)) } label: {
                        Image(systemName: "xmark").frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("消す")
                }
                .font(Comic.font(11))
                .foregroundStyle(Comic.trouble)
            } else {
                Text("受付中…")
                    .font(Comic.font(11))
                    .foregroundStyle(Comic.pageFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 60)
    }
}

import NatsumiCore
import SwiftUI

/// The main screen: the connection at the top, the notices under it, her balloon over her, and the input field at
/// the bottom. It is the only screen where she moves.
struct MainView: View {
    let props: PhoneMainProps
    let sinks: ScreenSinks

    var body: some View {
        // The page open over the main screen is in the props; the stack only shows it, and going back by the button
        // or by the swipe is raised as an event like any other.
        // An approval is pushed over their list, so going back from it by one leaves the list.
        NavigationStack(path: Binding(
            get: { props.page.map(PageRoute.path) ?? [] },
            set: { path in
                if path.isEmpty {
                    sinks.main(.pageClosed)
                } else if path.count < (props.page.map(PageRoute.path)?.count ?? 0) {
                    sinks.approval(.approvalClosed)
                }
            }
        )) {
            screen
                .toolbarVisibility(.hidden, for: .navigationBar)
                .navigationDestination(for: PageRoute.self) { route in
                    switch (route, props.page) {
                    case (_, .history(let history)):
                        HistoryView(props: history, sinks: sinks)
                    case (_, .settings(let settings)):
                        SettingsView(props: settings, send: sinks.settings, chooseRoute: sinks.settingsRoutes)
                    case (_, .approvals(let list)), (.approvals, .approval(_, let list)):
                        ApprovalListView(props: list, send: sinks.approvalRows)
                    case (_, .approval(let approval, _)):
                        ApprovalView(props: approval, sinks: sinks)
                    case (_, nil):
                        EmptyView()
                    }
                }
        }
        .tint(Comic.pageInk)
        // A picture opened large covers everything, the page under it included (ADR 0045).
        .fullScreenCover(isPresented: Binding(
            get: { props.viewer != nil },
            set: { if !$0 { sinks.viewer(.imageViewerClosed) } }
        )) {
            if let viewer = props.viewer {
                ImageViewerView(props: viewer, send: sinks.viewer)
            }
        }
    }

    private var screen: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if props.isComposing {
                    // The keyboard has half the screen: the status stands down for a way out of it.
                    Button { sinks.input(.inputFocusChanged(false)) } label: {
                        Label("閉じる", systemImage: "chevron.down")
                            .font(Comic.font(15))
                            .frame(height: 44)
                    }
                    .buttonStyle(.plain)
                } else {
                    StatusView(props: props.status, send: sinks.status)
                }
                Spacer()
                RoundButton(systemName: "text.bubble", label: "会話の履歴") { sinks.header(.historyOpenRequested) }
                if !props.isComposing {
                    RoundButton(systemName: "slider.horizontal.3", label: "設定") { sinks.header(.settingsOpenRequested) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            if let approvals = props.approvals {
                Button { sinks.approvalsEntry(.approvalsOpenRequested) } label: {
                    ApprovalEntryView(props: approvals)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }

            if let notices = props.notices {
                Button { sinks.notices(.historyOpenRequested) } label: {
                    NoticeCardView(props: notices)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.top, 16)
            }

            if props.isComposing {
                // She stands aside as a face while the owner writes, and what they just said is under her.
                VStack(alignment: .leading, spacing: 10) {
                    Spacer(minLength: 0)
                    HStack(alignment: .bottom, spacing: 10) {
                        FaceView(
                            avatar: props.character.avatar, expression: props.character.expression, size: 76)
                        switch props.balloon {
                        case .reply(let reply):
                            ReplyBalloonView(props: reply, tail: .leading, send: sinks.balloon)
                        case .thought(let thinking):
                            ThoughtBubbleView(props: thinking, width: nil, tail: .leading)
                        case nil:
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .frame(maxHeight: .infinity)
            } else {
                // The balloon takes what her standing place leaves, and only its own text scrolls when that is not
                // enough; the character and the input field stay where they are.
                GeometryReader { room in
                    VStack(spacing: 16) {
                        Spacer(minLength: 0)
                        switch props.balloon {
                        case .reply(let reply):
                            ReplyBalloonView(props: reply, send: sinks.balloon)
                        case .thought(let thinking):
                            ThoughtBubbleView(props: thinking)
                        case nil:
                            EmptyView()
                        }
                        CharacterView(props: props.character, maxHeight: room.size.height / 2)
                    }
                    .frame(width: room.size.width, height: room.size.height)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }

            VStack(alignment: .trailing, spacing: 10) {
                ForEach(props.outgoing) { item in
                    OutgoingRowView(props: item, send: sinks.failures)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, props.outgoing.isEmpty ? 0 : 4)
            InputBar(isComposing: props.isComposing, send: sinks.input)
        }
        .foregroundStyle(Comic.pageInk)
        .background(Comic.page)
    }
}

/// Which page is pushed. The page's own props come from the main props each time it is drawn.
enum PageRoute: Hashable {
    case history
    case settings
    case approvals
    case approval

    /// The pages on the stack: an approval is over the list of approvals.
    static func path(_ page: PhonePageProps) -> [PageRoute] {
        switch page {
        case .history: [.history]
        case .settings: [.settings]
        case .approvals: [.approvals]
        case .approval: [.approvals, .approval]
        }
    }
}

/// A round button with an ink outline, at the top right of the main screen.
struct RoundButton: View {
    let systemName: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Comic.pageInk)
                .frame(width: 44, height: 44)
                .background { InkedPaper(shape: Circle(), fill: Comic.surface, ink: Comic.pageInk) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Where the connection stands: a dot and a line, and a button when there is something to do about it.
struct StatusView: View {
    let props: PhoneStatusProps
    let send: PhoneEventSink

    var body: some View {
        let pill = HStack(spacing: 8) {
            Circle().fill(dot).frame(width: 8, height: 8)
            Text(props.text).lineLimit(1)
            if let action = props.action {
                Text(action.title).underline()
            }
        }
        .font(Comic.font(13))
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background { InkedPaper(shape: Capsule(), fill: Comic.surface, ink: Comic.pageInk, line: 2) }

        if let action = props.action {
            Button { send(action.event) } label: { pill }
                .buttonStyle(.plain)
        } else {
            pill
        }
    }

    private var dot: Color {
        switch props.tone {
        case .connected: Comic.connected
        case .waiting: Comic.waiting
        case .trouble: Comic.trouble
        }
    }
}

/// The yellow card of the notice in front, with the edges of those behind it.
struct NoticeCardView: View {
    let props: PhoneNoticeProps

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("お知らせ")
                Spacer()
                Text(props.count).foregroundStyle(Comic.noticeCount)
            }
            .font(Comic.font(12, bold: true))
            Text(props.text)
                .font(Comic.font(14))
                .lineLimit(1)
        }
        .foregroundStyle(Comic.ink)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background {
            ZStack {
                ForEach(Array(stride(from: props.edges, to: 0, by: -1)), id: \.self) { i in
                    InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.notice)
                        .padding(.horizontal, 6 * CGFloat(i))
                        .offset(y: 5 * CGFloat(i))
                }
                InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.notice)
            }
        }
        .padding(.bottom, 5 * CGFloat(props.edges))
    }
}

/// Her last reply, whole. The text scrolls inside the balloon when it is longer than the room it has.
struct ReplyBalloonView: View {
    let props: PhoneReplyProps
    /// Where it points at her: down when she stands under it, left when she is a face beside it.
    var tail: BalloonTailSide = .bottom
    let send: PhoneEventSink

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(props.header)
                    .font(Comic.font(12))
                    .foregroundStyle(Comic.faint)
                Spacer()
                Button { send(.balloonCloseTapped) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Comic.ink)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("既読にして閉じる")
                .padding(.vertical, -10)
            }
            ViewThatFits(in: .vertical) {
                text
                ScrollView { text }
                    .scrollIndicators(.visible)
            }
            if let thinking = props.thinking {
                ThinkingLine(props: thinking, size: 12)
                    .padding(.top, 6)
                    .overlay(alignment: .top) { Rectangle().fill(Comic.rule).frame(height: 2) }
            }
        }
        .foregroundStyle(Comic.ink)
        .padding(.leading, tail == .leading ? 16 + 9 : 16)
        .padding(.trailing, 4)
        .padding(.top, 6)
        .padding(.bottom, tail == .leading ? 12 : 12 + 9)
        .background { InkedPaper(shape: SpeechBalloonShape(side: tail)) }
        .opensLinks(through: send, as: PhoneEvent.linkTapped)
    }

    private var text: some View {
        Text(AttributedString(runs: props.runs))
            .font(Comic.font(16))
            .lineSpacing(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.trailing, 12)
            .textSelection(.enabled)
    }
}

/// The comic thought bubble while she is receiving or thinking, with small circles leading down to her.
struct ThoughtBubbleView: View {
    let props: ThinkingProps
    /// nil takes whatever width it is given; beside her standing place it keeps to its own.
    var width: CGFloat? = 260
    /// The trail of circles goes down at her, or down to the left at the face beside it.
    var tail: BalloonTailSide = .bottom

    var body: some View {
        ThinkingLine(props: props, size: 14)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .frame(maxWidth: width == nil ? .infinity : width, alignment: .leading)
            .background { InkedPaper(shape: RoundedRectangle(cornerRadius: 26)) }
            .overlay(alignment: tail == .leading ? .bottomLeading : .bottom) { trail }
            .padding(.bottom, 22)
    }

    private var trail: some View {
        ZStack(alignment: .topLeading) {
            InkedPaper(shape: Circle()).frame(width: 14, height: 14)
            InkedPaper(shape: Circle(), line: 2)
                .frame(width: 8, height: 8)
                .offset(x: tail == .leading ? -8 : 10, y: 14)
        }
        .frame(width: 24, height: 24, alignment: .topLeading)
        .offset(x: tail == .leading ? 14 : 0, y: 26)
    }
}

/// What she is thinking in one line: the line she is writing, or what she is doing until one arrives.
struct ThinkingLine: View {
    let props: ThinkingProps
    let size: CGFloat

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "ellipsis")
                .font(.system(size: size, weight: .bold))
            Text(props.line ?? "\(props.label)…")
                .font(Comic.font(size))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .foregroundStyle(Comic.faint)
    }
}

/// She stands on a little shadow of a floor, in the frame of the animation her face calls for.
struct CharacterView: View {
    let props: PhoneCharacterProps
    /// The most she and her floor may take; she is drawn smaller rather than pushed out.
    var maxHeight: CGFloat = .infinity

    /// A cell of the spritesheet is 192×208 pixels.
    private static let fullSize = CGSize(width: 176, height: 176 * 208 / 192)
    private static let floor: CGFloat = 12 + 6

    private var size: CGSize {
        let scale = min(1, max(0, maxHeight - Self.floor) / Self.fullSize.height)
        return CGSize(width: Self.fullSize.width * scale, height: Self.fullSize.height * scale)
    }

    var body: some View {
        let size = size
        VStack(spacing: 6) {
            switch props.avatar {
            case .sprite(let asset):
                TimelineView(.animation(minimumInterval: 1.0 / 12)) { context in
                    Image(
                        decorative: asset.frame(
                            for: props.expression, elapsed: context.date.timeIntervalSinceReferenceDate),
                        scale: 1
                    )
                    .resizable()
                    .interpolation(.high)
                    .frame(width: size.width, height: size.height)
                }
            case .placeholder:
                Text(PlaceholderArt.symbol(for: props.expression))
                    .font(.system(size: 96 * size.height / Self.fullSize.height))
                    .frame(width: size.width, height: size.height)
            }
            Ellipse().fill(Comic.floor).frame(width: 140, height: 12)
        }
        .accessibilityElement()
        .accessibilityLabel("なつみ")
    }
}

/// The text field and the yellow send button.
struct InputBar: View {
    /// The owner is in the field: the field says so, and the keyboard is up.
    var isComposing = false
    let send: PhoneEventSink

    @FocusState private var isFocused: Bool

    /// What the owner is typing. The input method keeps what it is converting on its own side, so the text belongs
    /// to the field until it is sent.
    @State private var draft = ""

    var body: some View {
        let isEmpty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        HStack(alignment: .bottom, spacing: 10) {
            TextField("話しかける", text: $draft, axis: .vertical)
                .font(Comic.font(16))
                .lineLimit(1...5)
                .focused($isFocused)
                .padding(.horizontal, 18)
                .padding(.vertical, 13)
                .frame(minHeight: 50)
                .background {
                    InkedPaper(shape: RoundedRectangle(cornerRadius: 25), fill: Comic.surface, ink: Comic.pageInk)
                        .overlay {
                            RoundedRectangle(cornerRadius: 25)
                                .stroke(Comic.notice, lineWidth: 3)
                                .padding(-3)
                                .opacity(isComposing ? 1 : 0)
                        }
                }
                // The keyboard being up is the mediator's to know, and its answer is what puts the caret in or
                // takes it out: the field says what happened, and follows what comes back.
                .onChange(of: isFocused) { send(.inputFocusChanged(isFocused)) }
                .onChange(of: isComposing) { if isFocused != isComposing { isFocused = isComposing } }
            Button {
                send(.inputSubmitted(draft))
                draft = ""
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(isEmpty ? Comic.disabledInk : Comic.ink)
                    .frame(width: 50, height: 50)
                    .background {
                        InkedPaper(
                            shape: Circle(), fill: isEmpty ? Comic.disabled : Comic.send,
                            ink: isEmpty ? Comic.disabledInk : Comic.ink)
                    }
            }
            .buttonStyle(.plain)
            .disabled(isEmpty)
            .accessibilityLabel("送る")
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }
}

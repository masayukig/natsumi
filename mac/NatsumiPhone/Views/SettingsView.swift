import NatsumiCore
import SwiftUI

/// The settings: the server and how the connection stands, the model routes, this iPhone, and logging out.
struct SettingsView: View {
    let props: PhoneSettingsProps
    let send: PhoneEventSink
    /// Where a model route is chosen from.
    let chooseRoute: PhoneEventSink

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                section("サーバー") {
                    row("URL") { Text(props.serverOrigin) }
                    divider
                    row("状態") {
                        HStack(spacing: 6) {
                            Circle().fill(dot).frame(width: 8, height: 8)
                            Text(props.status.text)
                        }
                    }
                    if let action = props.status.action {
                        divider
                        Button { send(action.event) } label: {
                            Text(action.title)
                                .font(Comic.font(15, bold: true))
                                .frame(maxWidth: .infinity, minHeight: 52)
                        }
                        .buttonStyle(.plain)
                    }
                }
                routes
                section("この端末") {
                    row("端末 ID") { Text(props.device.isEmpty ? "まだありません" : props.device) }
                }
                Button { send(.logoutRequested) } label: {
                    Text("ログアウト")
                        .font(Comic.font(16, bold: true))
                        .foregroundStyle(Comic.trouble)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background {
                            InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.surface, ink: Comic.pageInk)
                        }
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
        .foregroundStyle(Comic.pageInk)
        .background(Comic.page)
        .navigationTitle("設定")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Comic.page, for: .navigationBar)
    }

    /// What she talks with now, and the others to move her to from her next turn (ADR 0046).
    private var routes: some View {
        let routes = props.modelRoutes
        return section("モデル") {
            VStack(alignment: .leading, spacing: 6) {
                Text(routes.summary)
                    .font(Comic.font(15, bold: routes.isSilent))
                    .foregroundStyle(routes.isSilent ? Comic.trouble : Comic.pageInk)
                if let pending = routes.pending {
                    Text(pending).font(Comic.font(13, bold: true)).foregroundStyle(Comic.waiting)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            ForEach(routes.rows) { row in
                divider
                Button { chooseRoute(.modelRouteChosen(row.name)) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: row.isChosen ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 20))
                            .foregroundStyle(row.isChosen ? Comic.connected : Comic.pageFaint)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.name).font(Comic.font(15, bold: true))
                            Text(row.detail).font(Comic.font(12)).foregroundStyle(Comic.pageFaint)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(minLength: 8)
                        VStack(alignment: .trailing, spacing: 4) {
                            ForEach(row.tags, id: \.self) { tag in
                                Text(tag)
                                    .font(Comic.font(11, bold: true))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 2)
                                    .background(Comic.floor, in: Capsule())
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 60)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!row.isEnabled)
                .accessibilityIdentifier("model.route.\(row.name)")
            }
            if let message = routes.message {
                divider
                Text(message)
                    .font(Comic.font(13, bold: routes.isFailure))
                    .foregroundStyle(routes.isFailure ? Comic.trouble : Comic.pageFaint)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 16)
            }
            divider
            Text("切り替えは次のターンから効きます。会話の履歴も思考の記録もそのまま続きます。")
                .font(Comic.font(12))
                .foregroundStyle(Comic.pageFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
        }
    }

    private var dot: Color {
        switch props.status.tone {
        case .connected: Comic.connected
        case .waiting: Comic.waiting
        case .trouble: Comic.trouble
        }
    }

    private var divider: some View {
        Rectangle().fill(Comic.floor).frame(height: 2).padding(.horizontal, 16)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(Comic.font(13, bold: true))
                .foregroundStyle(Comic.pageFaint)
                .padding(.leading, 6)
            VStack(spacing: 0, content: content)
                .background {
                    InkedPaper(shape: RoundedRectangle(cornerRadius: 14), fill: Comic.surface, ink: Comic.pageInk)
                }
        }
    }

    private func row<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        HStack(spacing: 12) {
            Text(label).font(Comic.font(15))
            Spacer(minLength: 12)
            value()
                .font(Comic.font(14))
                .foregroundStyle(Comic.pageFaint)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
    }
}

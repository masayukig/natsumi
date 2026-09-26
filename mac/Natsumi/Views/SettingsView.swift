import NatsumiCore
import SwiftUI

struct SettingsView: View {
    let props: SettingsProps?
    let send: EventSink
    /// Text being typed. It is drawing-local: what counts is what the owner commits with the buttons below.
    @State private var server = ""
    @State private var avatarPath = ""

    var body: some View {
        if let props {
            Form {
                Section("サーバー") {
                    TextField("URL", text: $server, prompt: Text("https://natsumi.example.net"))
                        .onSubmit { send(.serverSubmitted(server)) }
                    HStack {
                        if let message = props.message {
                            Text(message).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("保存") { send(.serverSubmitted(server)) }
                    }
                }
                Section("アカウント") {
                    Text(props.statusText)
                    if let error = props.lastError { Text(error).font(.caption).foregroundStyle(.red) }
                    HStack {
                        Button("GitHub でログイン") { send(.loginRequested) }
                            .disabled(!props.canLogin)
                        Button("ログアウト") { send(.logoutRequested) }
                            .disabled(!props.canLogout)
                    }
                }
                ModelRoutesSection(props: props.modelRoutes, send: send)
                Section("キャラクター") {
                    LabeledContent("大きさ") {
                        HStack {
                            Slider(
                                value: Binding(
                                    get: { props.scale.value },
                                    set: { send(.characterScaleChanged(CharacterScale($0))) }),
                                in: CharacterScale.range, step: CharacterScale.step)
                            Text("\(props.scale.percent)%")
                                .monospacedDigit()
                                .frame(width: 48, alignment: .trailing)
                        }
                    }
                }
                Section("ショートカット") {
                    LabeledContent("会話のウインドウを出す") {
                        HStack {
                            Button(props.isRecordingHotKey ? "キーを押してください…" : props.hotKey) {
                                send(props.isRecordingHotKey ? .hotKeyRecordingCancelled : .hotKeyRecordingRequested)
                            }
                            .monospacedDigit()
                            Button("なし") { send(.hotKeyCleared) }
                                .disabled(!props.canClearHotKey)
                            Button("既定に戻す") { send(.hotKeyResetRequested) }
                                .disabled(!props.canResetHotKey)
                        }
                    }
                    if let message = props.hotKeyMessage {
                        Text(message).font(.caption).foregroundStyle(.red)
                    }
                    Text("どのアプリを使っていても効きます。ほかのアプリの同じショートカットより優先されます。ボタンを押してから、新しい組み合わせを押してください（Esc でやめる）。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("アバター") {
                    TextField("アセットのディレクトリ", text: $avatarPath)
                    Text(props.avatarDescription).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Spacer()
                        Button("既定に戻す") { send(.avatarDirectoryResetRequested) }
                        Button("読み込み直す") { send(.avatarDirectorySubmitted(avatarPath)) }
                    }
                }
            }
            .formStyle(.grouped)
            .frame(width: 480)
            .onAppear {
                server = props.serverOrigin
                avatarPath = props.avatarDirectory
            }
            // What was saved is what the fields show; a rejected URL leaves what was typed alone.
            .onChange(of: props.serverOrigin) { server = props.serverOrigin }
            .onChange(of: props.avatarDirectory) { avatarPath = props.avatarDirectory }
        }
    }
}

/// The model routes: what she talks with now, and the others to move her to from her next turn (ADR 0046).
struct ModelRoutesSection: View {
    let props: ModelRoutesProps
    let send: EventSink

    var body: some View {
        Section("モデル") {
            Text(props.summary)
                .fontWeight(props.isSilent ? .bold : .regular)
                .foregroundStyle(props.isSilent ? .red : .primary)
            if let pending = props.pending {
                Label(pending, systemImage: "arrow.forward.circle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            ForEach(props.rows) { row in
                HStack(spacing: 10) {
                    Image(systemName: row.isChosen ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(row.isChosen ? Color.accentColor : .secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name)
                        Text(row.detail).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    ForEach(row.tags, id: \.self) { tag in
                        Text(tag)
                            .font(.caption)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                    Button("切り替える") { send(.modelRouteChosen(row.name)) }
                        .disabled(!row.isEnabled)
                }
            }
            if let message = props.message {
                Text(message).font(.caption).foregroundStyle(props.isFailure ? .red : .secondary)
            }
            Text("切り替えは次のターンから効きます。会話の履歴も思考の記録もそのまま続きます。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

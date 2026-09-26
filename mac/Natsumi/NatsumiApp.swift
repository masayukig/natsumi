import AppKit
import NatsumiCore
import SwiftUI

@main
struct NatsumiApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra("natsumi", systemImage: "face.smiling") {
            MenuBarContent(model: delegate.menuBar)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let menuBar = MenuBarModel()
    private var root: RootComponent?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = RootComponent(menuBar: menuBar)
        self.root = root
        root.launch()
    }
}

/// The menu bar's scene cannot be handed a value the way a panel can, so it reads the props it was last given.
struct MenuBarContent: View {
    let model: MenuBarModel

    var body: some View {
        MenuContent(props: model.props, send: model.send)
    }
}

struct MenuContent: View {
    let props: MenuProps
    let send: EventSink

    var body: some View {
        Text(props.statusText)
        Button("話しかける") { send(.talkRequested) }
        Button("履歴を開く") { send(.historyOpenRequested) }
        if props.showsLogin {
            Button("GitHub でログイン") { send(.loginRequested) }
        }
        Menu(props.modelRoutes.menuTitle) {
            ForEach(props.modelRoutes.rows) { row in
                Toggle(isOn: Binding(get: { row.isChosen }, set: { _ in send(.modelRouteChosen(row.name)) })) {
                    Text(([row.name] + row.tags).joined(separator: " · "))
                }
                .disabled(!row.isEnabled)
            }
            if let pending = props.modelRoutes.pending { Text(pending) }
            if let message = props.modelRoutes.message { Text(message) }
        }
        Button("設定…") { send(.settingsOpenRequested) }
            .keyboardShortcut(",")
        Button("ログアウト") { send(.logoutRequested) }
            .disabled(!props.canLogout)
        Divider()
        Button("終了") { send(.quitRequested) }
            .keyboardShortcut("q")
    }
}

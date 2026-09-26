import Foundation

/// One route in the list the owner chooses from.
public struct ModelRouteRowProps: Equatable, Sendable, Identifiable {
    public var name: String
    /// "provider · model".
    public var detail: String
    /// 「使用中」「次のターンから」「既定」「使えません」, those that apply, in that order.
    public var tags: [String]
    /// The route the owner chose: it is marked.
    public var isChosen: Bool
    /// Choosing it would do something now.
    public var isEnabled: Bool

    public init(name: String, detail: String, tags: [String], isChosen: Bool, isEnabled: Bool) {
        self.name = name
        self.detail = detail
        self.tags = tags
        self.isChosen = isChosen
        self.isEnabled = isEnabled
    }

    public var id: String { name }
}

/// The model routes as the owner sees them, in the Mac's settings and menu and in the iPhone's settings (ADR 0046).
/// Choosing a row raises the route's name as the client's own event.
public struct ModelRoutesProps: Equatable, Sendable {
    /// What she is talking with now, or that she cannot talk.
    public var summary: String
    /// She cannot talk: no route is in use. The summary is to stand out.
    public var isSilent: Bool
    /// The route chosen for her next turn, while it is not the one in use.
    public var pending: String?
    /// The choice on its way, or why it was refused.
    public var message: String?
    public var isFailure: Bool
    /// In the config's order; empty until the server says the routes.
    public var rows: [ModelRouteRowProps]
    /// The title of the menu the routes are in on the Mac.
    public var menuTitle: String

    public init(
        summary: String, isSilent: Bool = false, pending: String? = nil, message: String? = nil, isFailure: Bool = false,
        rows: [ModelRouteRowProps] = [], menuTitle: String
    ) {
        self.summary = summary
        self.isSilent = isSilent
        self.pending = pending
        self.message = message
        self.isFailure = isFailure
        self.rows = rows
        self.menuTitle = menuTitle
    }
}

extension UIProps {
    /// The routes and the owner's choice, the same on both clients. Nothing can be chosen unless connected.
    public static func modelRoutes(_ book: ModelRouteBook, isConnected: Bool) -> ModelRoutesProps {
        guard let routes = book.routes else {
            return ModelRoutesProps(summary: "経路はまだ分かりません", menuTitle: "モデル: 不明")
        }
        let current = routes.current.flatMap(routes.route)
        let sending = book.choice?.status == .sending

        var summary = "なつみはいま話せません（使える経路がありません）"
        var menuTitle = "モデル: 話せません"
        if let name = routes.current {
            summary = current.map { "\($0.name)（\($0.model)）で話しています" } ?? "\(name) で話しています"
            menuTitle = "モデル: \(name)"
        }

        var pending: String?
        if routes.chosen != routes.current {
            if routes.route(routes.chosen)?.ready == false {
                pending = "\(routes.chosen) はいま使えません。使えるようになってから切り替わります"
            } else {
                pending = "次のターンから \(routes.chosen) に切り替わります"
            }
            if let name = routes.current { menuTitle = "モデル: \(name) → \(routes.chosen)" }
        }

        var message: String?
        var isFailure = false
        if let choice = book.choice {
            switch choice.status {
            case .sending:
                message = "\(choice.route) に切り替えています…"
            case .failed("unknown-route"):
                message = "\(choice.route) はサーバーの設定にありません"
            case .failed("route-unavailable"):
                message = "\(choice.route) はいま使えません"
            case .failed(let code):
                message = "\(choice.route) に切り替えられませんでした（\(code)）"
            case .unavailable(let code):
                message = "なつみが話せないため、切り替えられません（\(code)）"
            }
            isFailure = !sending
        }

        let rows = routes.routes.map { route in
            var tags: [String] = []
            if route.name == routes.current { tags.append("使用中") }
            if route.name == routes.chosen, routes.chosen != routes.current, routes.current != nil { tags.append("次のターンから") }
            if route.name == routes.defaultRoute { tags.append("既定") }
            if !route.ready { tags.append("使えません") }
            return ModelRouteRowProps(
                name: route.name, detail: "\(route.provider) · \(route.model)", tags: tags,
                isChosen: route.name == routes.chosen,
                isEnabled: isConnected && !sending && route.ready && route.name != routes.chosen)
        }
        return ModelRoutesProps(
            summary: summary, isSilent: routes.current == nil, pending: pending, message: message, isFailure: isFailure,
            rows: rows, menuTitle: menuTitle)
    }
}

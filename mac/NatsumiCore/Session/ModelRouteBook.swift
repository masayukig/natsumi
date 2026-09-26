import Foundation

/// The owner's choice of a model route on its way to the server.
public struct RouteChoice: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        /// Sent, or waiting for the sync to be sent.
        case sending
        /// The server refused it with this code (unknown-route, route-unavailable, invalid-request); the owner may
        /// choose again.
        case failed(String)
        /// natsumi cannot talk, so nothing can be chosen (`service.unavailable` with this code).
        case unavailable(String)
    }

    public let requestId: String
    public let route: String
    public var status: Status

    public init(requestId: String, route: String, status: Status) {
        self.requestId = requestId
        self.route = route
        self.status = status
    }
}

/// The model routes as the server says them, and the owner's choice not settled yet (client-contract「モデルの経路」).
public struct ModelRouteBook: Equatable, Sendable {
    /// nil until the server says them, and from a server that does not.
    public private(set) var routes: ModelRoutes?
    /// The owner's last choice while it is on its way, or why it was refused. It goes once the server takes it.
    public private(set) var choice: RouteChoice?

    public init() {}

    /// The choice to send (again) once synced: choosing a route is idempotent on the server.
    var unsent: RouteChoice? {
        choice?.status == .sending ? choice : nil
    }

    /// Records the owner's choice. Nothing is recorded — and so nothing sent — while an earlier choice is on its way,
    /// for a route that is already chosen, and for one not listed or not ready.
    mutating func choose(_ name: String, requestId: String) -> RouteChoice? {
        guard choice?.status != .sending, let routes, name != routes.chosen, routes.route(name)?.ready == true
        else { return nil }
        let choice = RouteChoice(requestId: requestId, route: name, status: .sending)
        self.choice = choice
        return choice
    }

    mutating func apply(_ event: ServerEvent, requestId: String? = nil) {
        switch event {
        case .snapshot(let snapshot):
            routes = snapshot.modelRoutes
            // What happened to a refusal is old news in a new sync; a choice the server already has needs no sending.
            switch choice?.status {
            case .sending:
                if choice?.route == routes?.chosen { choice = nil }
            case .failed, .unavailable:
                choice = nil
            case nil:
                break
            }
        case .modelRoutes(let routes):
            self.routes = routes
        case .accepted(let accepted):
            if let listed = accepted.modelRoutes {
                routes = listed
            }
            guard let requestId, choice?.requestId == requestId else { return }
            if let chosen = accepted.chosenRoute { routes?.chosen = chosen }
            choice = nil
        case .rejected(let code):
            guard let requestId, choice?.requestId == requestId else { return }
            // Sent before the sync: it goes again, under the same request ID, once synced.
            choice?.status = code == "sync-required" ? .sending : .failed(code)
        case .unavailable(let code, _):
            guard let requestId, choice?.requestId == requestId else { return }
            choice?.status = .unavailable(code)
        default:
            break
        }
    }
}

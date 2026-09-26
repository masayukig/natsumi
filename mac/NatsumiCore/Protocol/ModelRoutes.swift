import Foundation

/// One of the named routes natsumi's thinking can use (client-contract「モデルの経路」, ADR 0046). How it is reached —
/// the URL, the key, the login — stays on the server.
public struct ModelRoute: Codable, Equatable, Sendable {
    public let name: String
    /// Pi's provider and model, for showing only.
    public let provider: String
    public let model: String
    /// Whether it can be used now: false when its key cannot be read or its login is missing.
    public let ready: Bool

    public init(name: String, provider: String, model: String, ready: Bool) {
        self.name = name
        self.provider = provider
        self.model = model
        self.ready = ready
    }
}

/// The routes as the server says them: in the snapshot, in `model.routes`, and in the answer to `model.list`.
public struct ModelRoutes: Decodable, Equatable, Sendable {
    public let defaultRoute: String
    /// The route natsumi is using; nil while she cannot talk.
    public let current: String?
    /// The route the owner chose, or the default. When it is not `current`, she moves to it before her next turn, once
    /// it can be used.
    public var chosen: String
    /// In the config's order. A route this app cannot read is left out.
    public let routes: [ModelRoute]

    public init(defaultRoute: String, current: String?, chosen: String, routes: [ModelRoute]) {
        self.defaultRoute = defaultRoute
        self.current = current
        self.chosen = chosen
        self.routes = routes
    }

    private enum CodingKeys: String, CodingKey { case defaultRoute, current, chosen, routes }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            defaultRoute: try values.decode(String.self, forKey: .defaultRoute),
            current: try values.decodeIfPresent(String.self, forKey: .current),
            chosen: try values.decode(String.self, forKey: .chosen),
            routes: try values.decode(Lossy<ModelRoute>.self, forKey: .routes).elements)
    }

    public func route(_ name: String) -> ModelRoute? {
        routes.first { $0.name == name }
    }
}

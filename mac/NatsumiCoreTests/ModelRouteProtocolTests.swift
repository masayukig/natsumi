import Foundation
import Testing
@testable import NatsumiCore

@Suite("モデルの経路の envelope を読み、model.list・model.use を書く")
struct ModelRouteProtocolTests {
    private func event(_ data: Data) -> ServerEvent? {
        try? ServerEnvelope.decode(data).event
    }

    private let plus = ModelRoute(name: "plus", provider: "openai-codex", model: "example-plus-model", ready: true)

    @Test("snapshot の modelRoutes は、既定・今の経路・選んだ経路・一覧（設定の順）を運ぶ")
    func snapshot() {
        let data = Fixture.snapshot(seq: 1, modelRoutes: Fixture.modelRoutes(current: "local", chosen: "plus"))
        guard case .snapshot(let snapshot) = event(data) else { Issue.record("snapshot でない"); return }
        let routes = snapshot.modelRoutes
        #expect(routes?.defaultRoute == "local")
        #expect(routes?.current == "local")
        #expect(routes?.chosen == "plus")
        #expect(routes?.routes.map(\.name) == ["local", "plus", "spare"])
        #expect(routes?.routes.map(\.ready) == [true, true, false])
        #expect(routes?.routes[1] == plus)
        #expect(routes?.route("plus") == plus)
        #expect(routes?.route("nowhere") == nil)
    }

    @Test("current が null なら、natsumi は話せない")
    func currentNull() {
        guard case .snapshot(let snapshot) = event(Fixture.snapshot(seq: 1, modelRoutes: Fixture.modelRoutes(current: nil)))
        else { Issue.record("snapshot でない"); return }
        #expect(snapshot.modelRoutes?.current == nil)
        #expect(snapshot.modelRoutes?.chosen == "local")
    }

    @Test("modelRoutes の無い snapshot（古いサーバー）と、形の壊れた modelRoutes は、経路が分からないものとして読む")
    func missing() {
        guard case .snapshot(let old) = event(Fixture.snapshot(seq: 1)) else { Issue.record("snapshot でない"); return }
        #expect(old.modelRoutes == nil)
        let broken = Fixture.snapshot(seq: 1, modelRoutes: ["routes": "nothing"])
        guard case .snapshot(let snapshot) = event(broken) else { Issue.record("壊れた欄で snapshot を落とした"); return }
        #expect(snapshot.modelRoutes == nil)
    }

    @Test("一覧のうち読めない経路だけを落とし、知らない欄は読み飛ばす")
    func lossy() {
        var routes = Fixture.modelRoutes()
        var list = routes["routes"] as! [[String: Any]]
        list[1]["ready"] = "yes"
        list[2]["color"] = "blue"
        routes["routes"] = list
        routes["extra"] = 1
        guard case .modelRoutes(let read) = event(Fixture.envelope("model.routes", seq: 2, payload: routes))
        else { Issue.record("model.routes でない"); return }
        #expect(read.routes.map(\.name) == ["local", "spare"])
    }

    @Test("model.routes は modelRoutes と同じ形")
    func routesEvent() {
        let data = Fixture.envelope("model.routes", seq: 2, payload: Fixture.modelRoutes(current: "plus", chosen: "plus"))
        guard case .modelRoutes(let routes) = event(data) else { Issue.record("model.routes でない"); return }
        #expect(routes.current == "plus")
        #expect(routes.chosen == "plus")
        #expect(routes.routes.count == 3)
    }

    @Test("model.list への command.accepted は経路の全体を、model.use へのものは chosen と current を運ぶ")
    func accepted() {
        let list = Fixture.envelope("command.accepted", seq: 2, requestId: "r1", payload: Fixture.modelRoutes(chosen: "plus"))
        guard case .accepted(let listed) = event(list) else { Issue.record("command.accepted でない"); return }
        #expect(listed.modelRoutes?.chosen == "plus")
        #expect(listed.modelRoutes?.routes.count == 3)

        let use = Fixture.envelope("command.accepted", seq: 3, requestId: "r2", payload: ["chosen": "plus", "current": "local"])
        guard case .accepted(let used) = event(use) else { Issue.record("command.accepted でない"); return }
        #expect(used.chosenRoute == "plus")
        #expect(used.modelRoutes == nil)

        // Other answers carry neither.
        let read = Fixture.envelope("command.accepted", seq: 4, requestId: "r3", payload: ["readThroughMessageId": "m1", "unreadReplyCount": 0])
        guard case .accepted(let other) = event(read) else { Issue.record("command.accepted でない"); return }
        #expect(other.chosenRoute == nil)
        #expect(other.modelRoutes == nil)
    }

    @Test("model.list の payload は空、model.use は route")
    func encoding() {
        let list = Fixture.object(ClientEnvelope(requestId: "r1", deviceId: "device-1", command: .modelList))
        #expect(list["type"] as? String == "model.list")
        #expect((list["payload"] as? [String: Any])?.isEmpty == true)
        #expect(list["deviceId"] as? String == "device-1")

        let use = Fixture.object(ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .modelUse(route: "plus")))
        #expect(use["type"] as? String == "model.use")
        #expect(use["payload"] as? [String: String] == ["route": "plus"])
    }
}

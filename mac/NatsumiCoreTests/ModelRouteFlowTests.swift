import Foundation
import Testing
@testable import NatsumiCore

@Suite("モデルの経路を持ち、model.use を 1 回だけ送る")
struct ModelRouteFlowTests {
    private func machine() -> SessionMachine {
        var counter = 0
        return SessionMachine(deviceId: nil) {
            counter += 1
            return "r\(counter)"
        }
    }

    /// A machine synced with the server, with these routes.
    private func synced(_ routes: [String: Any] = Fixture.modelRoutes()) -> SessionMachine {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        _ = m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1", modelRoutes: routes))
        return m
    }

    private func sent(_ effects: [SessionEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .send(let envelope) = $0 { envelope } else { nil } }
    }

    @Test("snapshot の経路を持ち、model.routes で置き換える")
    func snapshotThenEvent() {
        var m = synced()
        #expect(m.modelRoutes.routes?.current == "local")
        _ = m.received(Fixture.envelope("model.routes", seq: 2, payload: Fixture.modelRoutes(current: "plus", chosen: "plus")))
        #expect(m.modelRoutes.routes?.current == "plus")
        #expect(m.modelRoutes.routes?.chosen == "plus")
    }

    @Test("経路を知らせない古いサーバーの snapshot では、経路は分からないまま")
    func oldServer() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        _ = m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1"))
        #expect(m.modelRoutes.routes == nil)
        #expect(m.chooseRoute("plus").isEmpty)
    }

    @Test("選ぶと model.use を送り、答えの chosen を選んだ経路にする")
    func choose() {
        var m = synced()
        let effects = m.chooseRoute("plus")
        #expect(sent(effects) == [ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .modelUse(route: "plus"))])
        #expect(m.modelRoutes.choice == RouteChoice(requestId: "r2", route: "plus", status: .sending))

        _ = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: "r2", payload: ["chosen": "plus", "current": "local"]))
        #expect(m.modelRoutes.choice == nil)
        #expect(m.modelRoutes.routes?.chosen == "plus")
        // It has not moved yet: that comes with model.routes.
        #expect(m.modelRoutes.routes?.current == "local")
    }

    @Test("答えより先に model.routes で移っていても、答えは今の経路を前に戻さない")
    func movedBeforeTheAnswer() {
        var m = synced()
        _ = m.chooseRoute("plus")
        _ = m.received(Fixture.envelope("model.routes", seq: 2, payload: Fixture.modelRoutes(current: "plus", chosen: "plus")))
        _ = m.received(Fixture.envelope("command.accepted", seq: 3, requestId: "r2", payload: ["chosen": "plus", "current": "local"]))
        #expect(m.modelRoutes.routes?.current == "plus")
        #expect(m.modelRoutes.routes?.chosen == "plus")
    }

    @Test("二重に押しても、1 回だけ送る")
    func onlyOnce() {
        var m = synced()
        #expect(sent(m.chooseRoute("plus")).count == 1)
        #expect(m.chooseRoute("plus").isEmpty)
        #expect(m.chooseRoute("local").isEmpty)
        _ = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: "r2", payload: ["chosen": "plus", "current": "local"]))
        // Once answered, the owner may choose again.
        #expect(sent(m.chooseRoute("local")).map(\.command) == [.modelUse(route: "local")])
    }

    @Test("選んである経路・使えない経路・一覧に無い経路は、送らない")
    func nothingToSend() {
        var m = synced(Fixture.modelRoutes(current: "local", chosen: "local"))
        #expect(m.chooseRoute("local").isEmpty)
        #expect(m.chooseRoute("spare").isEmpty)
        #expect(m.chooseRoute("nowhere").isEmpty)
        #expect(m.modelRoutes.choice == nil)
    }

    @Test("選んだ経路が今と違う間は、今の経路に戻すことを選べる")
    func backToCurrent() {
        var m = synced(Fixture.modelRoutes(current: "local", chosen: "plus"))
        #expect(sent(m.chooseRoute("local")).map(\.command) == [.modelUse(route: "local")])
    }

    @Test("unknown-route・route-unavailable・invalid-request で断られたら、その理由を持ち、選び直せる")
    func rejected() {
        for code in ["unknown-route", "route-unavailable", "invalid-request"] {
            var m = synced()
            _ = m.chooseRoute("plus")
            _ = m.received(Fixture.envelope("command.rejected", seq: 2, requestId: "r2", payload: ["code": code]))
            #expect(m.modelRoutes.choice?.status == .failed(code))
            #expect(m.modelRoutes.routes?.chosen == "local")
            #expect(sent(m.chooseRoute("plus")).count == 1)
            #expect(m.modelRoutes.choice?.status == .sending)
        }
    }

    @Test("natsumi が話せない間の service.unavailable も、断られたものとして持つ")
    func unavailable() {
        var m = synced()
        _ = m.chooseRoute("plus")
        _ = m.received(Fixture.envelope("service.unavailable", seq: 2, requestId: "r2", payload: ["code": "pi-unavailable"]))
        #expect(m.modelRoutes.choice?.status == .unavailable("pi-unavailable"))
        // The connection itself is still there.
        #expect(m.phase == .ready)
    }

    @Test("ほかの command の答えは、選んだものに触らない")
    func otherAnswers() {
        var m = synced()
        _ = m.chooseRoute("plus")
        _ = m.received(Fixture.envelope("command.rejected", seq: 2, requestId: "other", payload: ["code": "invalid-request"]))
        #expect(m.modelRoutes.choice?.status == .sending)
    }

    @Test("同期の前に選んだものは、同期してから送る。sync-required で断られたものも、同期のあとに同じ requestId で送り直す")
    func beforeSync() {
        var m = synced()
        _ = m.closed(.network)
        _ = m.reconnectTimerFired()
        #expect(m.chooseRoute("plus").isEmpty)
        let sync = sent(m.connected())[0]
        let resent = sent(m.received(Fixture.snapshot(
            seq: 1, stream: "stream-2", requestId: sync.requestId, deviceId: "device-1", modelRoutes: Fixture.modelRoutes())))
        #expect(resent.map(\.command) == [.modelUse(route: "plus")])
        let choice = resent[0].requestId

        _ = m.received(Fixture.envelope("command.rejected", seq: 2, stream: "stream-2", requestId: choice, payload: ["code": "sync-required"]))
        #expect(m.modelRoutes.choice?.status == .sending)
        _ = m.stop()
        _ = m.start()
        let again = sent(m.connected())[0]
        let resentAgain = sent(m.received(Fixture.snapshot(
            seq: 1, stream: "stream-3", requestId: again.requestId, deviceId: "device-1", modelRoutes: Fixture.modelRoutes())))
        #expect(resentAgain.map(\.requestId) == [choice])
    }

    @Test("同期し直して、選んだ経路がすでに選ばれていれば、送り直さない")
    func alreadyChosenAfterSync() {
        var m = synced()
        _ = m.closed(.network)
        _ = m.reconnectTimerFired()
        _ = m.chooseRoute("plus")
        let sync = sent(m.connected())[0]
        let resent = sent(m.received(Fixture.snapshot(
            seq: 1, stream: "stream-2", requestId: sync.requestId, deviceId: "device-1",
            modelRoutes: Fixture.modelRoutes(current: "local", chosen: "plus"))))
        #expect(resent.isEmpty)
        #expect(m.modelRoutes.choice == nil)
    }

    @Test("model.list を送り、答えで経路を置き換える。同期の前は送らない")
    func list() {
        var m = synced()
        #expect(sent(m.listRoutes()) == [ClientEnvelope(requestId: "r2", deviceId: "device-1", command: .modelList)])
        _ = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: "r2", payload: Fixture.modelRoutes(
            current: "local", chosen: "local", ready: ["local": true, "plus": false, "spare": true])))
        #expect(m.modelRoutes.routes?.routes.map(\.ready) == [true, false, true])

        _ = m.closed(.network)
        #expect(m.listRoutes().isEmpty)
    }
}

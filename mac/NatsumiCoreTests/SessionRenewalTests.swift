import Foundation
import Testing
@testable import NatsumiCore

/// The session lasts 30 days from its last use, and the server says so whenever it moves (ADR 0030).
@Suite("セッションの期限を、サーバーが延ばした分だけ手元でも延ばす", .serialized)
struct SessionRenewalTests {
    private static let later = "2026-10-23T06:00:00.000Z"
    private static let laterDate = parseTimestamp(later)!

    private func machine() -> SessionMachine {
        var counter = 0
        return SessionMachine(deviceId: nil) {
            counter += 1
            return "r\(counter)"
        }
    }

    private func snapshot(seq: Int, requestId: String?, expiresAt: String? = later) -> Data {
        var object = try! JSONSerialization.jsonObject(with: Fixture.snapshot(seq: seq, requestId: requestId, deviceId: "device-1"))
            as! [String: Any]
        var payload = object["payload"] as! [String: Any]
        if let expiresAt { payload["sessionExpiresAt"] = expiresAt }
        object["payload"] = payload
        return Fixture.json(object)
    }

    private func renewed(seq: Int, stream: String = Fixture.stream, expiresAt: String = later) -> Data {
        Fixture.envelope("session.renewed", seq: seq, stream: stream, payload: ["expiresAt": expiresAt])
    }

    // MARK: Reading the envelope

    @Test("session.renewed は延びた期限として読む")
    func decodeRenewed() {
        #expect(Fixture.decoded(renewed(seq: 3)).event == .sessionRenewed(expiresAt: Self.laterDate))
    }

    @Test("同期への答えの sessionExpiresAt を読む。無い答えは nil")
    func decodeSyncAnswers() {
        #expect(Fixture.decoded(snapshot(seq: 1, requestId: "r1")).sessionExpiresAt == Self.laterDate)
        #expect(Fixture.decoded(snapshot(seq: 1, requestId: "r1", expiresAt: nil)).sessionExpiresAt == nil)
        let resume = Fixture.decoded(Fixture.envelope("command.accepted", seq: 2, requestId: "r1",
            payload: ["deviceId": "device-1", "mode": "resume", "sessionExpiresAt": Self.later]))
        #expect(resume.sessionExpiresAt == Self.laterDate)
        let unavailable = Fixture.decoded(Fixture.envelope("service.unavailable", seq: 2, requestId: "r1",
            payload: ["code": "pi-unavailable", "deviceId": "device-1", "sessionExpiresAt": Self.later]))
        #expect(unavailable.sessionExpiresAt == Self.laterDate)
    }

    // MARK: The stream

    @Test("session.renewed は採番しないので、どの stream でも同期の前でも適用し、位置を動かさない")
    func trackerAppliesAnywhere() {
        var before = StreamTracker()
        #expect(before.accept(Fixture.decoded(renewed(seq: 0, stream: "stream-temporary"))) == .apply)
        #expect(before.position == nil)

        let at = StreamPosition(epoch: Fixture.epoch, streamId: Fixture.stream, seq: 4)
        var tracker = StreamTracker(position: at)
        #expect(tracker.accept(Fixture.decoded(renewed(seq: 4))) == .apply)
        #expect(tracker.accept(Fixture.decoded(renewed(seq: 9))) == .apply)
        #expect(tracker.accept(Fixture.decoded(renewed(seq: 1, stream: "stream-other"))) == .apply)
        #expect(tracker.position == at)
    }

    // MARK: The session machine

    @Test("snapshot の期限で、セッションを延ばす")
    func snapshotExtends() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        #expect(m.received(snapshot(seq: 1, requestId: "r1")).contains(.extendSession(until: Self.laterDate)))
    }

    @Test("期限の無い snapshot では、何も延ばさない")
    func snapshotWithoutExpiry() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        let effects = m.received(snapshot(seq: 1, requestId: "r1", expiresAt: nil))
        #expect(!effects.contains { if case .extendSession = $0 { true } else { false } })
    }

    @Test("resume の答えと service.unavailable の期限でも延ばす")
    func resumeAndUnavailableExtend() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        _ = m.received(snapshot(seq: 1, requestId: "r1"))
        _ = m.closed(.network)
        _ = m.reconnectTimerFired()
        _ = m.connected()
        let resumed = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: "r2",
            payload: ["deviceId": "device-1", "mode": "resume", "sessionExpiresAt": "2026-10-24T00:00:00.000Z"]))
        #expect(resumed.contains(.extendSession(until: parseTimestamp("2026-10-24T00:00:00.000Z")!)))

        var other = machine()
        _ = other.start()
        _ = other.connected()
        let unavailable = other.received(Fixture.envelope("service.unavailable", seq: 1, requestId: "r1",
            payload: ["code": "pi-unavailable", "deviceId": "device-1", "sessionExpiresAt": Self.later]))
        #expect(unavailable.contains(.extendSession(until: Self.laterDate)))
    }

    @Test("接続中に届いた session.renewed で延ばし、会話には何も起きない")
    func renewedWhileConnected() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        _ = m.received(snapshot(seq: 1, requestId: "r1", expiresAt: nil))
        let conversation = m.conversation
        #expect(m.received(renewed(seq: 1)) == [.extendSession(until: Self.laterDate)])
        #expect(m.conversation == conversation)
        // The number was not taken: the next event is still seq 2.
        _ = m.received(Fixture.envelope("avatar.expression", seq: 2, payload: ["expression": "happy"]))
        #expect(m.conversation.expression == .happy)
    }

    @Test("同期の前に届いた session.renewed でも延ばす")
    func renewedBeforeSync() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        #expect(m.received(renewed(seq: 0, stream: "stream-temporary")) == [.extendSession(until: Self.laterDate)])
        #expect(m.phase == .syncing)
    }

    // MARK: The store

    @Test("保存した期限より後のときだけ、同じトークンのまま期限を置き換える")
    func storeExtendsOnlyForward() throws {
        let suite = "natsumi-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = AccountStore(secrets: MemorySecretStore(), defaults: defaults)
        let now = Date(timeIntervalSince1970: 1_000)
        try store.saveSession(SessionGrant(token: "SYNTHETIC-TOKEN", expiresAt: Date(timeIntervalSince1970: 2_000)))

        store.extendSession(until: Date(timeIntervalSince1970: 1_500))
        #expect(store.session(at: now) == SessionGrant(token: "SYNTHETIC-TOKEN", expiresAt: Date(timeIntervalSince1970: 2_000)))

        store.extendSession(until: Date(timeIntervalSince1970: 9_000))
        #expect(store.session(at: now) == SessionGrant(token: "SYNTHETIC-TOKEN", expiresAt: Date(timeIntervalSince1970: 9_000)))
    }

    @Test("セッションが無ければ、延ばしても作らない")
    func storeWithoutSession() {
        let suite = "natsumi-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = AccountStore(secrets: MemorySecretStore(), defaults: defaults)
        store.extendSession(until: Self.laterDate)
        #expect(store.session(at: Date(timeIntervalSince1970: 0)) == nil)
    }

    // MARK: The mediators

    @Test("Mac の Mediator は、延ばす効果をそのまま出す")
    func macMediator() {
        var counter = 0
        var mediator = UIMediator { counter += 1; return "r\(counter)" }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: "https://natsumi.example.net")))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        #expect(mediator.handle(.socketReceived(snapshot(seq: 1, requestId: "r1"))).contains(.extendSession(until: Self.laterDate)))
    }

    @Test("iPhone の Mediator は、延ばす効果をそのまま出す")
    func phoneMediator() {
        var counter = 0
        var mediator = PhoneMediator { counter += 1; return "r\(counter)" }
        _ = mediator.handle(.launched(serverOrigin: "https://natsumi.example.net"))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        #expect(mediator.handle(.socketReceived(snapshot(seq: 1, requestId: "r1"))).contains(.extendSession(until: Self.laterDate)))
    }
}

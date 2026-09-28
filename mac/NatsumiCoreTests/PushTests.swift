import CryptoKit
import Foundation
import Testing
@testable import NatsumiCore

/// The shared vector the server's tests make and check (ADR 0029). Its keys are disposable and for tests only.
private struct Vector: Decodable {
    struct KeyPair: Decodable { let privateKey: String; let publicKey: String }
    struct Intermediate: Decodable { let sharedSecret: String; let salt: String; let key: String }
    struct Sealed: Decodable { let v: Int; let epk: String; let nonce: String; let ct: String }

    let info: String
    let device: KeyPair
    let ephemeral: KeyPair
    let nonce: String
    let messageId: String
    let plaintext: String
    let intermediate: Intermediate
    let e: Sealed

    static func load() throws -> Vector {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/push/vector-v1.json")
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    var devicePrivateKey: P256.KeyAgreement.PrivateKey {
        try! P256.KeyAgreement.PrivateKey(rawRepresentation: Data(base64Encoded: device.privateKey)!)
    }

    /// `e` as it arrives in the payload: an object, not a string.
    var eObject: [String: Any] { ["v": e.v, "epk": e.epk, "nonce": e.nonce, "ct": e.ct] }
}

private func data(_ base64: String) -> Data { Data(base64Encoded: base64)! }

@Suite("通知の本文を端末の秘密鍵で開く（共通のテストベクタ）")
struct PushCryptoTests {
    @Test("途中の値（共有の秘密・salt・鍵）がサーバーと一致する")
    func intermediates() throws {
        let vector = try Vector.load()
        #expect(vector.info == PushCrypto.info)
        let epk = data(vector.e.epk)
        let device = vector.devicePrivateKey
        #expect(device.publicKey.x963Representation == data(vector.device.publicKey))

        let secret = try PushCrypto.sharedSecret(device, epk: epk)
        #expect(secret.withUnsafeBytes { Data($0) } == data(vector.intermediate.sharedSecret))
        #expect(PushCrypto.salt(epk: epk, device: device.publicKey) == data(vector.intermediate.salt))
        let key = PushCrypto.symmetricKey(secret, epk: epk, device: device.publicKey)
        #expect(key.withUnsafeBytes { Data($0) } == data(vector.intermediate.key))
    }

    @Test("e を開くと、平文の本文と気持ちが出る")
    func open() throws {
        let vector = try Vector.load()
        let alert = try #require(AlertPush(userInfo: [
            "messageId": vector.messageId, "kind": "reply", "position": 42, "e": vector.eObject,
        ]))
        let text = try PushCrypto.open(#require(alert.sealed), messageId: alert.messageId, with: vector.devicePrivateKey)
        let expected = try JSONSerialization.jsonObject(with: Data(vector.plaintext.utf8)) as! [String: String]
        #expect(text == PushText(text: expected["text"]!, expression: expected["expression"]))
    }

    @Test("messageId が違えば開けない（AAD）")
    func wrongMessageId() throws {
        let vector = try Vector.load()
        let alert = try #require(AlertPush(userInfo: ["messageId": vector.messageId, "kind": "reply", "position": 1, "e": vector.eObject]))
        #expect(throws: (any Error).self) {
            try PushCrypto.open(alert.sealed!, messageId: "message-other", with: vector.devicePrivateKey)
        }
    }

    @Test("別の端末の鍵では開けない")
    func wrongKey() throws {
        let vector = try Vector.load()
        let alert = try #require(AlertPush(userInfo: ["messageId": vector.messageId, "kind": "reply", "position": 1, "e": vector.eObject]))
        #expect(throws: (any Error).self) {
            try PushCrypto.open(alert.sealed!, messageId: vector.messageId, with: P256.KeyAgreement.PrivateKey())
        }
    }

    @Test("気持ちの無い平文も開ける")
    func withoutExpression() throws {
        #expect(try PushText(json: Data(#"{"text":"古いセリフ"}"#.utf8)) == PushText(text: "古いセリフ", expression: nil))
    }
}

@Suite("通知の payload を読む")
struct PushPayloadTests {
    @Test("alert は平文の messageId・kind・position と、暗号文の e を持つ")
    func alert() {
        let alert = AlertPush(userInfo: [
            "aps": ["alert": ["title": "なつみ", "body": "知らせがあります"], "mutable-content": 1],
            "messageId": "m7", "kind": "notice", "position": 7,
            "e": ["v": 1, "epk": "AQ==", "nonce": "Ag==", "ct": "Aw=="],
        ])
        #expect(alert == AlertPush(messageId: "m7", kind: .notice, position: 7,
            sealed: SealedPushText(epk: Data([1]), nonce: Data([2]), ct: Data([3]))))
    }

    @Test("e が無い・版が違う・base64 でないときは、開けないものとして読む")
    func alertWithoutUsableE() {
        let base: [AnyHashable: Any] = ["messageId": "m1", "kind": "reply", "position": 1]
        #expect(AlertPush(userInfo: base)?.sealed == nil)
        var other = base
        other["e"] = ["v": 2, "epk": "AQ==", "nonce": "Ag==", "ct": "Aw=="]
        #expect(AlertPush(userInfo: other)?.sealed == nil)
        other["e"] = ["v": 1, "epk": "not base64!", "nonce": "Ag==", "ct": "Aw=="]
        #expect(AlertPush(userInfo: other)?.sealed == nil)
    }

    @Test("natsumi の通知でないものは読まない")
    func notOurs() {
        #expect(AlertPush(userInfo: ["aps": ["alert": "x"]]) == nil)
        #expect(AlertPush(userInfo: ["messageId": "m1", "kind": "message", "position": 1]) == nil)
        #expect(BackgroundPush(userInfo: ["aps": ["content-available": 1]]) == nil)
    }

    @Test("background は aps の外のバッジと、既読の位置・確認した知らせを持つ")
    func background() {
        #expect(BackgroundPush(userInfo: ["aps": ["content-available": 1], "kind": "read", "badge": 1, "readThroughPosition": 42])
            == BackgroundPush(badge: 1, readThroughPosition: 42, notificationId: nil))
        #expect(BackgroundPush(userInfo: ["aps": ["content-available": 1], "kind": "acked", "badge": 0, "notificationId": "m3"])
            == BackgroundPush(badge: 0, readThroughPosition: nil, notificationId: "m3"))
    }
}

@Suite("届いている通知の片づけ")
struct PushTidyTests {
    private func reply(_ id: String, _ position: Int) -> AlertPush { AlertPush(messageId: id, kind: .reply, position: position, sealed: nil) }
    private func notice(_ id: String, _ position: Int) -> AlertPush { AlertPush(messageId: id, kind: .notice, position: position, sealed: nil) }

    @Test("background では、既読の位置までの返事と、確認した知らせを消す")
    func background() {
        let tidy = PushTidy.background(BackgroundPush(badge: 2, readThroughPosition: 10, notificationId: "n5"))
        #expect(tidy.badge == 2)
        #expect(tidy.removes(reply("r9", 9)))
        #expect(tidy.removes(reply("r10", 10)))
        #expect(!tidy.removes(reply("r11", 11)))
        #expect(tidy.removes(notice("n5", 5)))
        // Crossing a notice does not check it (ADR 0013).
        #expect(!tidy.removes(notice("n6", 6)))
    }

    @Test("カーソルが無ければ、返事は消さない")
    func backgroundWithoutCursor() {
        let tidy = PushTidy.background(BackgroundPush(badge: 1, readThroughPosition: nil, notificationId: "n1"))
        #expect(!tidy.removes(reply("r1", 1)))
        #expect(tidy.removes(notice("n1", 1)))
    }

    @Test("同期した状態では、まだ未読の返事と未確認の知らせだけを残す")
    func synced() {
        let tidy = PushTidy.synced(badge: 2, unreadReplyIds: ["r2"], unacknowledgedIds: ["n3"])
        #expect(tidy.badge == 2)
        #expect(!tidy.removes(reply("r2", 2)))
        #expect(tidy.removes(reply("r1", 1)))
        #expect(!tidy.removes(notice("n3", 3)))
        #expect(tidy.removes(notice("n4", 4)))
    }
}

@Suite("通知の登録を送る")
struct PushRegistrationTests {
    private func machine() -> SessionMachine {
        var counter = 0
        return SessionMachine(deviceId: nil) {
            counter += 1
            return "r\(counter)"
        }
    }

    private func sent(_ effects: [SessionEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .send(let envelope) = $0 { envelope } else { nil } }
    }

    private let registration = PushRegistration(token: "0a1b", publicKey: "BPmE", environment: .sandbox)

    @Test("device token は 16 進の小文字、公開鍵は X9.63 の標準の base64 にする")
    func fromDevice() {
        let key = P256.KeyAgreement.PrivateKey().publicKey
        let made = PushRegistration(deviceToken: Data([0x0A, 0xFF, 0x00]), publicKey: key, environment: .production)
        #expect(made.token == "0aff00")
        #expect(made.publicKey == key.x963Representation.base64EncodedString())
        #expect(made.environment == .production)
    }

    @Test("push.register の envelope")
    func encoding() {
        let object = Fixture.object(ClientEnvelope(requestId: "r9", deviceId: "device-1", command: .pushRegister(registration)))
        #expect(object["type"] as? String == "push.register")
        #expect(object["payload"] as? [String: String] == ["token": "0a1b", "publicKey": "BPmE", "environment": "sandbox"])
    }

    @Test("同期の前に渡した登録は、同期が済んでから送る")
    func beforeSync() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        #expect(sent(m.registerPush(registration)).isEmpty)
        let effects = m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1"))
        #expect(sent(effects).map(\.command) == [.pushRegister(registration)])
        #expect(sent(effects).first?.deviceId == "device-1")
    }

    @Test("同期した後に渡した登録は、すぐ送る")
    func whenReady() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        _ = m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1"))
        #expect(sent(m.registerPush(registration)).map(\.command) == [.pushRegister(registration)])
    }

    @Test("つなぎ直して同期するたびに、登録を送り直す")
    func everySync() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        _ = m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1"))
        _ = m.registerPush(registration)
        _ = m.stop()
        _ = m.start()
        let sync = sent(m.connected())[0]
        let effects = m.received(Fixture.envelope("command.accepted", seq: 2, requestId: sync.requestId,
            payload: ["deviceId": "device-1", "mode": "resume"]))
        #expect(sent(effects).map(\.command) == [.pushRegister(registration)])
    }

    @Test("登録が無ければ、同期しても何も送らない")
    func nothingToRegister() {
        var m = machine()
        _ = m.start()
        _ = m.connected()
        #expect(sent(m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1"))).isEmpty)
    }
}

@Suite("iPhone の Mediator と通知")
struct PhonePushTests {
    private let registration = PushRegistration(token: "0a1b", publicKey: "BPmE", environment: .sandbox)

    private func mediator(hasSession: Bool = true) -> PhoneMediator {
        var counter = 0
        var mediator = PhoneMediator { counter += 1; return "r\(counter)" }
        _ = mediator.handle(.launched(serverOrigin: "https://natsumi.example.net"))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: hasSession, deviceId: nil))
        return mediator
    }

    private func tidies(_ effects: [PhoneEffect]) -> [PushTidy] {
        effects.compactMap { if case .tidyNotifications(let tidy) = $0 { tidy } else { nil } }
    }

    private func sentCommands(_ effects: [PhoneEffect]) -> [ClientCommand] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope.command } else { nil } }
    }

    @Test("セッションがあれば、通知の許可と登録を求める。無ければ求めない")
    func asksForNotifications() {
        var withSession = PhoneMediator()
        _ = withSession.handle(.launched(serverOrigin: "https://natsumi.example.net"))
        _ = withSession.handle(.avatarLoaded(Fixture.receivedAvatar))
        #expect(withSession.handle(.sessionResumed(hasSession: true, deviceId: nil)).contains(.registerForNotifications))

        var without = PhoneMediator()
        _ = without.handle(.launched(serverOrigin: "https://natsumi.example.net"))
        _ = without.handle(.avatarLoaded(Fixture.receivedAvatar))
        #expect(!without.handle(.sessionResumed(hasSession: false, deviceId: nil)).contains(.registerForNotifications))
    }

    @Test("届いた登録は、同期してから push.register で送る")
    func registersAfterSync() {
        var m = mediator()
        #expect(sentCommands(m.handle(.pushRegistrationReady(registration))).isEmpty)
        _ = m.handle(.socketOpened)
        let effects = m.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1")))
        #expect(sentCommands(effects) == [.pushRegister(registration)])
    }

    @Test("ログアウトしてログインし直しても、同じ登録を送る")
    func registrationOutlivesLogout() {
        var m = mediator()
        _ = m.handle(.pushRegistrationReady(registration))
        _ = m.handle(.logoutRequested)
        _ = m.handle(.loginSubmitted(server: "https://natsumi.example.net"))
        _ = m.handle(.loginFinished(.succeeded))
        _ = m.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = m.handle(.socketOpened)
        let effects = m.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1")))
        #expect(sentCommands(effects).contains(.pushRegister(registration)))
    }

    @Test("同期したら、未読の数をバッジにし、読んだものの通知を片づける")
    func tidiesAfterSync() {
        var m = mediator()
        _ = m.handle(.socketOpened)
        let effects = m.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1",
            messages: [Fixture.message("m1"), Fixture.message("m2"), Fixture.message("n3", kind: "notice")],
            readThrough: "m1", unreadReplyCount: 1, unacknowledged: ["n3"])))
        #expect(tidies(effects) == [.synced(badge: 2, unreadReplyIds: ["m2"], unacknowledgedIds: ["n3"])])
    }

    @Test("同じ状態では片づけを繰り返さず、読んだら片づけ直す")
    func tidiesOnlyOnChange() {
        var m = mediator()
        _ = m.handle(.socketOpened)
        _ = m.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: [Fixture.message("m1")], unreadReplyCount: 1)))
        #expect(tidies(m.handle(.inputFocusChanged(true))).isEmpty)
        let read = m.handle(.socketReceived(Fixture.envelope("conversation.read", seq: 2,
            payload: ["readThroughMessageId": "m1", "unreadReplyCount": 0])))
        #expect(tidies(read) == [.synced(badge: 0, unreadReplyIds: [], unacknowledgedIds: [])])
    }

    @Test("前に戻って同期し直したら、同じ状態でも片づけ直す")
    func tidiesAgainAfterReturning() {
        var m = mediator()
        _ = m.handle(.socketOpened)
        _ = m.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1")))
        _ = m.handle(.enteredBackground)
        _ = m.handle(.becameActive)
        _ = m.handle(.socketOpened)
        let effects = m.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r2", deviceId: "device-1")))
        #expect(tidies(effects) == [.synced(badge: 0, unreadReplyIds: [], unacknowledgedIds: [])])
    }

    @Test("同期していない間は片づけない")
    func noTidyBeforeSync() {
        var m = mediator()
        #expect(tidies(m.handle(.socketOpened)).isEmpty)
    }

    @Test("background push は、その中身で片づける")
    func backgroundPush() {
        var m = mediator()
        let push = BackgroundPush(badge: 1, readThroughPosition: 4, notificationId: nil)
        #expect(m.handle(.backgroundPushReceived(push)) == [.tidyNotifications(.background(push))])
    }
}

@Suite("通知の送り先と鍵")
struct PushEnvironmentAndKeyTests {
    private func profile(_ environment: String) -> Data {
        Data("""
        garbage before the plist\u{0}\u{1}<?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>Entitlements</key><dict>
        <key>aps-environment</key>
        \t<string>\(environment)</string>
        </dict></dict></plist>\u{0}garbage after
        """.utf8)
    }

    @Test("署名の provisioning profile の aps-environment で送り先を決める")
    func fromProfile() {
        #expect(PushEnvironment(provisioningProfile: profile("development")) == .sandbox)
        #expect(PushEnvironment(provisioningProfile: profile("production")) == .production)
    }

    @Test("profile が無い（App Store から入れた）なら production")
    func withoutProfile() {
        #expect(PushEnvironment(provisioningProfile: nil) == .production)
        #expect(PushEnvironment(provisioningProfile: Data("no entitlement here".utf8)) == .production)
    }

    @Test("鍵は一度作ったら同じものを返す")
    func keyStaysTheSame() throws {
        let store = PushKeyStore(service: "natsumi-tests-\(UUID().uuidString)", accessGroup: nil)
        defer { try? store.delete() }
        #expect(try store.load() == nil)
        let made = try store.loadOrCreate()
        #expect(try store.loadOrCreate().rawRepresentation == made.rawRepresentation)
        #expect(try store.load()?.rawRepresentation == made.rawRepresentation)
    }
}

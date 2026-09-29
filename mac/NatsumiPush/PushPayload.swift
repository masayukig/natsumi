import CryptoKit
import Foundation

// Built into NatsumiCore and into the Notification Service Extension, which does not link NatsumiCore: the extension
// has to open the text before the notification shows, and needs nothing else (ADR 0029).

/// What natsumi said, as the server sealed it for this iPhone.
public struct PushText: Equatable, Sendable {
    public let text: String
    /// The feeling she put into the line (ADR 0026), as the server wrote it. nil on lines from before it was kept.
    public let expression: String?
    /// Her face for the feeling, to fetch and attach (ADR 0057): https only, and nil when the server sent none.
    public let icon: URL?

    public init(text: String, expression: String?, icon: URL? = nil) {
        self.text = text
        self.expression = expression
        self.icon = icon
    }

    /// The plaintext: `{"text": …, "expression": …, "icon": …}` in UTF-8. An icon that is not an https URL is dropped,
    /// and the line is still read.
    init(json: Data) throws {
        guard let object = try JSONSerialization.jsonObject(with: json) as? [String: Any], let text = object["text"] as? String
        else { throw PushError.malformed }
        let icon = (object["icon"] as? String).flatMap(URL.init(string:)).flatMap { url in
            url.scheme?.lowercased() == "https" && url.host?.isEmpty == false ? url : nil
        }
        self.init(text: text, expression: object["expression"] as? String, icon: icon)
    }
}

/// A Slack post waiting for the owner, as the server sealed it: how the draft begins, and where it would go.
public struct ApprovalPushText: Equatable, Sendable {
    public let text: String
    public let channel: String

    public init(text: String, channel: String) {
        self.text = text
        self.channel = channel
    }

    /// The plaintext: `{"text": …, "channel": …}` in UTF-8.
    init(json: Data) throws {
        guard let object = try JSONSerialization.jsonObject(with: json) as? [String: Any],
              let text = object["text"] as? String, let channel = object["channel"] as? String
        else { throw PushError.malformed }
        self.init(text: text, channel: channel)
    }
}

/// `e` of an alert: the ephemeral public key, the nonce, and the ciphertext followed by its tag.
public struct SealedPushText: Equatable, Sendable {
    public let epk: Data
    public let nonce: Data
    public let ct: Data

    public init(epk: Data, nonce: Data, ct: Data) {
        self.epk = epk
        self.nonce = nonce
        self.ct = ct
    }

    /// Only version 1 is known; anything else reads as nothing to open.
    init?(_ value: Any?) {
        guard let object = value as? [String: Any], object["v"] as? Int == 1,
              let epk = (object["epk"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let nonce = (object["nonce"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let ct = (object["ct"] as? String).flatMap({ Data(base64Encoded: $0) })
        else { return nil }
        self.init(epk: epk, nonce: nonce, ct: ct)
    }
}

/// An alert for one of natsumi's lines: a reply or a notice.
public struct AlertPush: Equatable, Sendable {
    public enum Kind: String, Sendable { case reply, notice }

    public let messageId: String
    public let kind: Kind
    /// The line's place in the conversation, to tidy it away once read.
    public let position: Int
    /// nil when there is nothing this app can open; the fixed text of the alert then stays.
    public let sealed: SealedPushText?

    public init(messageId: String, kind: Kind, position: Int, sealed: SealedPushText?) {
        self.messageId = messageId
        self.kind = kind
        self.position = position
        self.sealed = sealed
    }

    /// The payload's plain fields, or nil when it is not one of natsumi's alerts.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let messageId = userInfo["messageId"] as? String,
              let kind = (userInfo["kind"] as? String).flatMap(Kind.init(rawValue:)),
              let position = userInfo["position"] as? Int
        else { return nil }
        self.init(messageId: messageId, kind: kind, position: position, sealed: SealedPushText(userInfo["e"]))
    }
}

/// An alert that a Slack post is waiting for the owner (`kind: approval`). It carries no place in the conversation:
/// it is tidied away by its approval ID.
public struct ApprovalAlertPush: Equatable, Sendable {
    public let approvalId: String
    /// nil when there is nothing this app can open; the fixed text of the alert then stays.
    public let sealed: SealedPushText?

    public init(approvalId: String, sealed: SealedPushText?) {
        self.approvalId = approvalId
        self.sealed = sealed
    }

    public init?(userInfo: [AnyHashable: Any]) {
        guard userInfo["kind"] as? String == "approval", let approvalId = userInfo["approvalId"] as? String else { return nil }
        self.init(approvalId: approvalId, sealed: SealedPushText(userInfo["e"]))
    }
}

/// A silent push after an approval was closed, here or on another device (`kind: approval-resolved`).
public struct ApprovalResolvedPush: Equatable, Sendable {
    public let approvalId: String
    /// Unread replies, unchecked notices and pending approvals, as the server counted them.
    public let badge: Int

    public init(approvalId: String, badge: Int) {
        self.approvalId = approvalId
        self.badge = badge
    }

    public init?(userInfo: [AnyHashable: Any]) {
        guard userInfo["kind"] as? String == "approval-resolved", let approvalId = userInfo["approvalId"] as? String,
              let badge = userInfo["badge"] as? Int
        else { return nil }
        self.init(approvalId: approvalId, badge: badge)
    }
}

/// A silent push after the owner read or checked something, likely on another device.
public struct BackgroundPush: Equatable, Sendable {
    /// Unread replies and unchecked notices, as the server counted them.
    public let badge: Int
    /// The read position; replies at or before it are read. nil when nothing was ever read.
    public let readThroughPosition: Int?
    /// The notice checked, on a push for a check.
    public let notificationId: String?

    public init(badge: Int, readThroughPosition: Int?, notificationId: String?) {
        self.badge = badge
        self.readThroughPosition = readThroughPosition
        self.notificationId = notificationId
    }

    public init?(userInfo: [AnyHashable: Any]) {
        guard let kind = userInfo["kind"] as? String, kind == "read" || kind == "acked", let badge = userInfo["badge"] as? Int
        else { return nil }
        self.init(
            badge: badge, readThroughPosition: userInfo["readThroughPosition"] as? Int,
            notificationId: userInfo["notificationId"] as? String)
    }
}

public enum PushError: Error, Equatable {
    case malformed
}

/// Opens what the server sealed to this iPhone's public key: ECDH with the ephemeral key, HKDF-SHA256, AES-256-GCM
/// (ADR 0029). The steps match the server's and are checked against the shared vector.
public enum PushCrypto {
    static let info = "natsumi-push-v1"

    public static func open(
        _ sealed: SealedPushText, messageId: String, with key: P256.KeyAgreement.PrivateKey
    ) throws -> PushText {
        try PushText(json: open(sealed, authenticating: messageId, with: key))
    }

    /// The same steps for an approval, whose ID is the additional data.
    public static func openApproval(
        _ sealed: SealedPushText, approvalId: String, with key: P256.KeyAgreement.PrivateKey
    ) throws -> ApprovalPushText {
        try ApprovalPushText(json: open(sealed, authenticating: approvalId, with: key))
    }

    static func open(_ sealed: SealedPushText, authenticating id: String, with key: P256.KeyAgreement.PrivateKey) throws -> Data {
        let secret = try sharedSecret(key, epk: sealed.epk)
        let box = try AES.GCM.SealedBox(combined: sealed.nonce + sealed.ct)
        return try AES.GCM.open(
            box, using: symmetricKey(secret, epk: sealed.epk, device: key.publicKey), authenticating: Data(id.utf8))
    }

    static func sharedSecret(_ key: P256.KeyAgreement.PrivateKey, epk: Data) throws -> SharedSecret {
        try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: epk))
    }

    /// The ephemeral public key, then this iPhone's, both X9.63.
    static func salt(epk: Data, device: P256.KeyAgreement.PublicKey) -> Data {
        epk + device.x963Representation
    }

    static func symmetricKey(_ secret: SharedSecret, epk: Data, device: P256.KeyAgreement.PublicKey) -> SymmetricKey {
        secret.hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: salt(epk: epk, device: device), sharedInfo: Data(info.utf8), outputByteCount: 32)
    }
}

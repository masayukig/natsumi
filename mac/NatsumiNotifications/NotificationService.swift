import Foundation
import ImageIO
import UserNotifications

/// Opens natsumi's line before the notification shows (ADR 0029). The server sealed it to this iPhone's key; the
/// alert it sent says only 「返事があります」, 「知らせがあります」 or 「承認待ちがあります」, and that stays whenever the
/// line cannot be opened.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        if let approval = ApprovalAlertPush(userInfo: request.content.userInfo) {
            contentHandler(Self.approvalContent(request.content, approval) ?? request.content)
            return
        }
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
              let alert = AlertPush(userInfo: content.userInfo), let sealed = alert.sealed,
              let key = try? PushKeyStore(accessGroup: PushKeyStore.sharedGroup()).load(),
              let line = try? PushCrypto.open(sealed, messageId: alert.messageId, with: key)
        else {
            contentHandler(request.content)
            return
        }
        content.body = line.text
        if alert.kind == .notice { content.subtitle = "知らせ" }
        guard let icon = line.icon else {
            contentHandler(content)
            return
        }
        // Her face for the feeling comes from the server, whose URL was sealed with the line (ADR 0057). The line is
        // shown whatever becomes of it: without the face when it cannot be had in time.
        let delivery = Delivery(content: content, handler: contentHandler)
        self.delivery = delivery
        var fetch = URLRequest(url: icon, timeoutInterval: Self.faceTimeout)
        fetch.httpMethod = "GET"
        URLSession.shared.dataTask(with: fetch) { data, response, _ in
            delivery.finish(face: (response as? HTTPURLResponse)?.statusCode == 200 ? data.flatMap(Face.attachment) : nil)
        }.resume()
    }

    /// iOS is about to give up on the extension: the line goes out as it is, without her face.
    override func serviceExtensionTimeWillExpire() {
        delivery?.finish(face: nil)
    }

    /// Well within the time iOS gives the extension.
    private static let faceTimeout: TimeInterval = 10

    /// The line waiting for her face.
    private var delivery: Delivery?

    /// A Slack post waiting for the owner: where it would go, and how the draft begins (ADR 0041). Tapping it opens
    /// the approval in the app.
    private static func approvalContent(_ original: UNNotificationContent, _ alert: ApprovalAlertPush) -> UNNotificationContent? {
        guard let content = original.mutableCopy() as? UNMutableNotificationContent, let sealed = alert.sealed,
              let key = try? PushKeyStore(accessGroup: PushKeyStore.sharedGroup()).load(),
              let draft = try? PushCrypto.openApproval(sealed, approvalId: alert.approvalId, with: key)
        else { return nil }
        content.subtitle = "承認待ち · \(draft.channel)"
        content.body = draft.text
        return content
    }
}

/// Her face as the server serves it for Slack: a PNG, written out for the notification to attach.
private enum Face {
    static func attachment(_ data: Data) -> UNNotificationAttachment? {
        // Only a picture is attached, whatever else the URL may have answered with.
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).png")
        guard (try? data.write(to: url)) != nil else { return nil }
        return try? UNNotificationAttachment(identifier: "face", url: url)
    }
}

/// A line waiting for her face, which goes out exactly once: with the face when it comes, or without it when the
/// fetch fails or iOS runs out of time, whichever is first.
private final class Delivery: @unchecked Sendable {
    private let lock = NSLock()
    private var content: UNMutableNotificationContent?
    private let handler: (UNNotificationContent) -> Void

    init(content: UNMutableNotificationContent, handler: @escaping (UNNotificationContent) -> Void) {
        self.content = content
        self.handler = handler
    }

    func finish(face: UNNotificationAttachment?) {
        lock.lock()
        let content = self.content
        self.content = nil
        lock.unlock()
        guard let content else { return }
        if let face { content.attachments = [face] }
        handler(content)
    }
}

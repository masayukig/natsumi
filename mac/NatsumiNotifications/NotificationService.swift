import Foundation
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
        // Her face is not added: the avatar is the server's and the app keeps its copy where this extension cannot
        // read it, and none is bundled any more (ADR 0057).
        contentHandler(content)
    }

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

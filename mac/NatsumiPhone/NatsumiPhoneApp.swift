import NatsumiCore
import SwiftUI
import UserNotifications

@main
struct NatsumiPhoneApp: App {
    /// Holds the root, since what iOS says about notifications arrives at the app delegate.
    @UIApplicationDelegateAdaptor private var delegate: PhoneAppDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ScreenView(model: delegate.root.model)
        }
        .onChange(of: scenePhase) { _, phase in delegate.root.scenePhaseChanged(phase) }
    }
}

/// The only thing that holds the root (ADR 0028). It passes on what iOS says about notifications (ADR 0029).
@MainActor
final class PhoneAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let root: PhoneRootComponent = {
        let root = PhoneRootComponent()
        root.launch()
        return root
    }()

    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set before launching ends, so that the tap that launched the app is heard too.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// The owner tapped a notification: an approval's opens that approval; the others just bring the app up.
    /// Not `async`: UIKit's handler must be called on the main thread (`MainThreadCompletion`).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let id = ApprovalAlertPush(userInfo: response.notification.request.content.userInfo)?.approvalId
        MainThreadCompletion.run({ if let id { self.root.approvalNotificationOpened(id) } }, then: completionHandler)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        root.deviceTokenReceived(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Without a token there is nothing to register; the app works as before, and the next launch asks again.
    }

    func application(
        _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]
    ) async -> UIBackgroundFetchResult {
        await root.remoteNotificationReceived(userInfo) ? .newData : .noData
    }
}

/// Draws whichever screen the props say is up.
struct ScreenView: View {
    let model: ScreenModel

    var body: some View {
        switch model.props.screen {
        case .login(let props):
            LoginView(props: props, send: model.sinks.login)
        case .main(let props):
            MainView(props: props, sinks: model.sinks)
        }
    }
}

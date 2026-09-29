import AppIntents
import SwiftUI
import WidgetKit

/// Ways to open the app from the lock screen: a button for its bottom corners
/// (also Control Center and the Action button) and a face under the clock.
/// Both only open the app; they show nothing of the conversation. They cannot read the avatar the app received, so
/// they do not name her (ADR 0057).
@main
struct NatsumiWidgets: WidgetBundle {
    var body: some Widget {
        LaunchControl()
        LaunchWidget()
    }
}

struct LaunchControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "io.github.yuanying.natsumi.phone.launch-control") {
            ControlWidgetButton(action: OpenNatsumiIntent()) {
                Label("会話", systemImage: "bubble.left.fill")
            }
        }
        .displayName("会話を開く")
        .description("会話のアプリを開きます。")
    }
}

struct LaunchWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "io.github.yuanying.natsumi.phone.launch-widget", provider: LaunchTimeline()) { _ in
            LaunchWidgetView()
        }
        .configurationDisplayName("会話を開く")
        .description("タップすると会話のアプリを開きます。")
        .supportedFamilies([.accessoryCircular])
    }
}

/// The face never changes, so the timeline is a single entry.
struct LaunchTimeline: TimelineProvider {
    func placeholder(in context: Context) -> LaunchEntry { LaunchEntry(date: .now) }

    func getSnapshot(in context: Context, completion: @escaping (LaunchEntry) -> Void) {
        completion(LaunchEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LaunchEntry>) -> Void) {
        completion(Timeline(entries: [LaunchEntry(date: .now)], policy: .never))
    }
}

struct LaunchEntry: TimelineEntry {
    let date: Date
}

struct LaunchWidgetView: View {
    var body: some View {
        Image("Face")
            .resizable()
            .widgetAccentedRenderingMode(.fullColor)
            .scaledToFill()
            .clipShape(Circle())
            .containerBackground(for: .widget) { AccessoryWidgetBackground() }
            .accessibilityLabel("会話を開く")
    }
}

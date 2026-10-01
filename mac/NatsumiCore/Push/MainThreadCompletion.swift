import Foundation

/// Calls a completion handler that UIKit gave the app delegate, on the main thread.
///
/// The handlers for a tapped notification and for a background push update the app's snapshot, and UIKit asserts that
/// this happens on the main thread. Written as `async`, such a delegate method has Swift's bridging thunk call the
/// handler wherever its task finishes: on the cooperative pool, since that task is not isolated to the main actor even
/// when the method is. So the delegate takes the handler and passes it here.
public enum MainThreadCompletion {
    /// Does `work` on the main actor, then calls `completion` with its result on the main thread. It may be entered on
    /// any thread.
    public static func run<Value: Sendable>(
        _ work: @escaping @MainActor () async -> Value, then completion: @escaping @Sendable (Value) -> Void
    ) {
        Task { @MainActor in completion(await work()) }
    }
}

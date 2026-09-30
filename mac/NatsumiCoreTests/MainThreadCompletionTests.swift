import Foundation
import Synchronization
import Testing
@testable import NatsumiCore

/// UIKit hands the app delegate completion handlers that must be called on the main thread. The delegate methods are
/// entered outside the main actor, so they are called here from a background queue, as the notification center may.
@Suite("通知の delegate: completion を main で呼ぶ")
struct MainThreadCompletionTests {
    /// What happened, in order, and whether it was on the main thread.
    private final class Log: Sendable {
        private let entries = Mutex<[(String, Bool)]>([])
        func add(_ name: String) { entries.withLock { $0.append((name, Thread.isMainThread)) } }
        var names: [String] { entries.withLock { $0.map(\.0) } }
        var onMain: [Bool] { entries.withLock { $0.map(\.1) } }
    }

    private func run<Value: Sendable>(
        _ work: @escaping @MainActor () async -> Value, log: Log
    ) async -> Value {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                MainThreadCompletion.run(work) { value in
                    log.add("completion")
                    continuation.resume(returning: value)
                }
            }
        }
    }

    @Test("main 以外のキューから入っても、仕事と completion を main で呼ぶ")
    func onMain() async {
        let log = Log()
        let value = await run({ log.add("work"); return 7 }, log: log)
        #expect(value == 7)
        #expect(log.names == ["work", "completion"])
        #expect(log.onMain == [true, true])
    }

    @Test("仕事が main の外で待っても、completion は main で呼ぶ")
    func afterSuspension() async {
        let log = Log()
        await run({
            log.add("work")
            await Task.detached { log.add("elsewhere") }.value
            log.add("resumed")
        }, log: log)
        #expect(log.names == ["work", "elsewhere", "resumed", "completion"])
        #expect(log.onMain == [true, false, true, true])
    }
}

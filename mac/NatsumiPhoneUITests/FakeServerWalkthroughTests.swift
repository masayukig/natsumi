import XCTest

/// Walks the iPhone app through the fake server (`npm run fake-server`) and keeps a screenshot of every step.
///
/// This is for looking at the screens, not a gate: it needs the fake server on http://localhost:8787, which the
/// simulator reaches as the Mac's own loopback. Screenshots are attached to the result bundle, and are also written
/// to `$NATSUMI_SCREENSHOTS` when it is set (pass it as `TEST_RUNNER_NATSUMI_SCREENSHOTS` to xcodebuild).
/// `$NATSUMI_SERVER` points it at a fake server on another port.
@MainActor
final class FakeServerWalkthroughTests: XCTestCase {
    private let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testWalkthrough() throws {
        app.launch()
        logInIfAsked()

        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 15), "つながらない")
        shoot("2-main")

        let close = app.buttons["既読にして閉じる"]
        if close.waitForExistence(timeout: 2) {
            close.tap()
            shoot("3-read")
        }

        let field = app.textFields["話しかける"]
        field.tap()
        field.typeText("明日の午前って空いてる？")
        shoot("4-typing")
        app.buttons["送る"].tap()
        sleep(1)
        shoot("5-sent")
        XCTAssertTrue(app.staticTexts["メモを読み返してる"].waitForExistence(timeout: 10))
        shoot("6-thinking")
        XCTAssertTrue(app.staticTexts["「明日の午前って空いてる？」だね。わかった。"].waitForExistence(timeout: 15))
        shoot("7-reply")

        // 「閉じる」 takes the keyboard away, and the main screen is back as it was.
        app.buttons["閉じる"].tap()
        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 5))
        shoot("8-closed")

        app.buttons["会話の履歴"].tap()
        XCTAssertTrue(app.navigationBars["会話"].waitForExistence(timeout: 5))
        sleep(1)
        shoot("9-history")
        app.navigationBars.buttons.firstMatch.tap()
        // Everything was seen in the history, so the notice card is gone.
        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 5))
        shoot("10-main-after-history")

        app.buttons["設定"].tap()
        XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 5))
        shoot("11-settings")
        app.buttons["ログアウト"].tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5))
        shoot("12-logged-out")
    }

    /// The Slack posts waiting for the owner (ADR 0041): one arrives while the main screen is up, and each of the three
    /// is closed a different way — approved, edited and rejected. Logging out at the end puts the fake server's
    /// approvals back, so this can run again.
    func testApprovalWalkthrough() throws {
        app.launch()
        logInIfAsked()
        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 15), "つながらない")

        // Two are waiting at the start, and the fake server sends a third a few seconds after the sync.
        let entry = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "承認待ち 3 件")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 20), "3 件目が届かない")
        shoot("a1-main")
        entry.tap()
        XCTAssertTrue(app.navigationBars["承認待ち"].waitForExistence(timeout: 5))
        shoot("a2-list")

        // A reply in a thread, sent back twice before: approved as it is.
        row("work/#dev").tap()
        XCTAssertTrue(app.navigationBars["承認"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["同じ返信先で 3 回目の突き返しになりました"].exists)
        shoot("a3-detail")
        app.swipeUp()
        shoot("a4-detail-below")
        app.buttons["承認して送る"].tap()
        XCTAssertTrue(app.staticTexts["承認して送りました"].waitForExistence(timeout: 10))
        shoot("a5-approved")
        back()

        // The one that arrived: moved to the channel and edited.
        row("work/@佐藤").tap()
        XCTAssertTrue(app.navigationBars["承認"].waitForExistence(timeout: 5))
        app.buttons["チャンネル"].tap()
        XCTAssertTrue(app.staticTexts["チャンネルに投稿"].exists)
        app.buttons["修正"].tap()
        let field = app.textFields["approval.editor.text"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        // The caret starts at the beginning of the draft: what is typed goes in front of it.
        field.tap()
        field.typeText("確認しました。")
        shoot("a6-editing")
        app.buttons["修正して送る"].tap()
        XCTAssertTrue(app.staticTexts["修正して送りました"].waitForExistence(timeout: 10))
        // What was sent is the owner's text, with the addition.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "確認しました。")).firstMatch.exists)
        shoot("a7-edited")
        back()

        // A post to the channel itself has no thread to choose: rejected.
        row("work/#random").tap()
        XCTAssertTrue(app.navigationBars["承認"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["スレッド"].exists)
        app.buttons["却下"].tap()
        XCTAssertTrue(app.staticTexts["却下しました"].waitForExistence(timeout: 10))
        shoot("a8-rejected")
        back()

        XCTAssertTrue(app.staticTexts["承認待ちはありません"].waitForExistence(timeout: 5))
        shoot("a9-none-left")
        back()
        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "承認待ち")).firstMatch.exists)

        app.buttons["設定"].tap()
        app.buttons["ログアウト"].tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5))
    }

    /// Pictures (ADR 0044, ADR 0045): the reply of the fake server that shows two pictures has them small in the
    /// history, and the post to the channel has its two on the page of the approval. Each opens full screen and
    /// closes with 閉じる.
    func testImageWalkthrough() throws {
        app.launch()
        logInIfAsked()
        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 15), "つながらない")

        app.buttons["会話の履歴"].tap()
        XCTAssertTrue(app.navigationBars["会話"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["昨日描いた絵も見てね。"].waitForExistence(timeout: 5))
        // A picture is a button once it has come.
        let first = app.buttons["画像 1/2"]
        XCTAssertTrue(first.waitForExistence(timeout: 10), "履歴に画像が出ない")
        XCTAssertTrue(app.buttons["画像 2/2"].waitForExistence(timeout: 10))
        shoot("i1-history-images")
        first.tap()
        let close = app.buttons["閉じる"]
        XCTAssertTrue(close.waitForExistence(timeout: 5), "拡大が開かない")
        shoot("i2-history-viewer")
        close.tap()
        XCTAssertTrue(app.navigationBars["会話"].waitForExistence(timeout: 5))
        back()

        let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "承認待ち")).firstMatch
        XCTAssertTrue(entry.waitForExistence(timeout: 10))
        entry.tap()
        row("work/#random").tap()
        XCTAssertTrue(app.navigationBars["承認"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["一緒に送る画像"].waitForExistence(timeout: 5))
        let picture = app.buttons["画像 2/2"]
        XCTAssertTrue(picture.waitForExistence(timeout: 10), "承認の詳細に画像が出ない")
        shoot("i3-approval-images")
        picture.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        shoot("i4-approval-viewer")
        close.tap()
        XCTAssertTrue(app.navigationBars["承認"].waitForExistence(timeout: 5))
        back()
        back()

        app.buttons["設定"].tap()
        app.buttons["ログアウト"].tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5))
    }

    /// The model routes (ADR 0046): the settings show the route in use and the list, `plus` is chosen, the settings
    /// say it comes from the next turn, and the fake server moves to it a moment later. The route that is not ready
    /// cannot be chosen. Logging out at the end puts the fake server's routes back, so this can run again.
    func testModelRouteSwitch() throws {
        app.launch()
        logInIfAsked()
        XCTAssertTrue(app.staticTexts["つながっています"].waitForExistence(timeout: 15), "つながらない")

        app.buttons["設定"].tap()
        XCTAssertTrue(app.navigationBars["設定"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["local（example-model）で話しています"].waitForExistence(timeout: 5))
        let plus = app.buttons["model.route.plus"]
        XCTAssertTrue(plus.waitForExistence(timeout: 5), "plus の行が無い")
        XCTAssertFalse(app.buttons["model.route.spare"].isEnabled)
        XCTAssertFalse(app.buttons["model.route.local"].isEnabled)
        shoot("m1-routes")

        plus.tap()
        XCTAssertTrue(app.staticTexts["次のターンから plus に切り替わります"].waitForExistence(timeout: 5))
        shoot("m2-next-turn")
        XCTAssertTrue(app.staticTexts["plus（example-plus-model）で話しています"].waitForExistence(timeout: 10), "移らない")
        XCTAssertFalse(app.staticTexts["次のターンから plus に切り替わります"].exists)
        XCTAssertTrue(app.buttons["model.route.local"].isEnabled)
        shoot("m3-switched")

        app.buttons["ログアウト"].tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5))
    }

    /// The row of the list for a channel.
    private func row(_ channel: String) -> XCUIElement {
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", channel)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "\(channel) の行が無い")
        return row
    }

    private func back() {
        app.navigationBars.buttons.firstMatch.tap()
        sleep(1)
    }

    /// The login screen, when the app has no session: the fake server's address, the button, and the system's
    /// question whether the app may sign in with it.
    private func logInIfAsked() {
        let button = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "GitHub でログイン")).firstMatch
        guard button.waitForExistence(timeout: 5) else { return }
        shoot("1-login")
        let field = app.textFields.firstMatch
        field.tap()
        if let old = field.value as? String, !old.isEmpty, old != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
        }
        field.typeText(ProcessInfo.processInfo.environment["NATSUMI_SERVER"] ?? "http://localhost:8787")
        button.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for title in ["続ける", "Continue"] {
            let allow = springboard.buttons[title]
            if allow.waitForExistence(timeout: 3) {
                allow.tap()
                break
            }
        }
        // Once logged in, the app asks whether it may show notifications (ADR 0029).
        for title in ["許可", "Allow"] {
            let allow = springboard.buttons[title]
            if allow.waitForExistence(timeout: 3) {
                allow.tap()
                break
            }
        }
    }

    private func shoot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["NATSUMI_SCREENSHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}

import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("舞台: 一枚の透明なウインドウの中の配置")
struct StageTests {
    /// The stage covers a screen whose bottom left is not the origin: a second display to the right.
    private let stage = CGRect(x: 1000, y: 100, width: 800, height: 600)

    @Test("画面の座標（左下が原点）を、舞台の座標（左上が原点）に直す")
    func onStage() {
        // A rectangle standing on the stage's bottom edge, 50 in from its left.
        let rect = CGRect(x: 1050, y: 100, width: 100, height: 200)
        #expect(StageLayout.onStage(rect, stage: stage) == CGRect(x: 50, y: 400, width: 100, height: 200))
        // One touching the top edge.
        let top = CGRect(x: 1000, y: 650, width: 80, height: 50)
        #expect(StageLayout.onStage(top, stage: stage) == CGRect(x: 0, y: 0, width: 80, height: 50))
    }

    @Test("舞台の描画パラメータは、列の配置を舞台の座標に直し、無いパネルの枠は無い")
    func stageProps() {
        var mediator = UIMediator { "r" }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: nil)))
        let root = UIProps.root(mediator.state, placement: ColumnPlacement(), time: .example)
        let character = CGRect(x: 1400, y: 150, width: 100, height: 100)
        var layout = OverlayLayout()
        layout.balloon = CGRect(x: 1330, y: 258, width: 240, height: 80)
        let props = StageProps.make(root: root, character: character, layout: layout, stage: stage, transition: .card)
        #expect(props.size == stage.size)
        #expect(props.characterFrame == CGRect(x: 400, y: 450, width: 100, height: 100))
        #expect(props.balloonFrame == CGRect(x: 330, y: 362, width: 240, height: 80))
        #expect(props.noticesFrame == nil)
        #expect(props.balloon == root.balloon)
        #expect(props.notices == root.notices)
        #expect(props.character == root.character)
        #expect(props.transition == .card)
    }

    @Test("走りの途中の位置: 始めは出発点、終わりは目的地、真ん中は中点で、始めと終わりはゆっくり")
    func placeDuringARun() {
        let from = CGPoint(x: 0, y: 0), to = CGPoint(x: 200, y: 100)
        #expect(CharacterRun.place(from: from, to: to, duration: 1, elapsed: 0) == from)
        #expect(CharacterRun.place(from: from, to: to, duration: 1, elapsed: -1) == from)
        #expect(CharacterRun.place(from: from, to: to, duration: 1, elapsed: 1) == to)
        #expect(CharacterRun.place(from: from, to: to, duration: 1, elapsed: 5) == to)
        let middle = CharacterRun.place(from: from, to: to, duration: 1, elapsed: 0.5)
        #expect(abs(middle.x - 100) < 0.01 && abs(middle.y - 50) < 0.01)
        // Ease in: a quarter of the time covers less than a quarter of the way.
        let early = CharacterRun.place(from: from, to: to, duration: 1, elapsed: 0.25)
        #expect(early.x > 0 && early.x < 50)
        // Ease out: three quarters of the time covers more than three quarters of the way.
        let late = CharacterRun.place(from: from, to: to, duration: 1, elapsed: 0.75)
        #expect(late.x > 150 && late.x < 200)
        // A run of no time is over at once.
        #expect(CharacterRun.place(from: from, to: to, duration: 0, elapsed: 0) == to)
    }

    @Test("同じ曲線の進み具合は単調に増える")
    func curveIsMonotone() {
        var last: CGFloat = 0
        for step in 1...20 {
            let progress = CharacterRun.progress(at: CGFloat(step) / 20)
            #expect(progress >= last)
            last = progress
        }
        #expect(CharacterRun.progress(at: 0) == 0)
        #expect(abs(CharacterRun.progress(at: 1) - 1) < 0.0001)
    }

    @Test("以前の版がウインドウの枠として覚えた位置を読み替える")
    func legacyOrigin() {
        // "x y width height screenX screenY screenWidth screenHeight", as AppKit saves a window's frame.
        #expect(CharacterPlace.legacyOrigin("1493 90 192 208 0 0 1710 1085 ") == CGPoint(x: 1493, y: 90))
        #expect(CharacterPlace.legacyOrigin("-12.5 40 192 208") == CGPoint(x: -12.5, y: 40))
        #expect(CharacterPlace.legacyOrigin("") == nil)
        #expect(CharacterPlace.legacyOrigin("abc def") == nil)
        #expect(CharacterPlace.legacyOrigin("100") == nil)
    }
}

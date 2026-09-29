import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("キャラクターの居場所と、走っての移動")
struct CharacterPlaceTests {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
    private let character = CGRect(x: 400, y: 300, width: 100, height: 100)

    private func mediator(at frame: CGRect? = nil, visible: CGRect? = nil) -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: nil)))
        _ = mediator.handle(.characterFrameChanged(frame ?? character, visible: visible ?? screen))
        return mediator
    }

    private func moves(_ effects: [UIEffect]) -> [CGPoint] {
        effects.compactMap { if case .moveCharacter(let to) = $0 { to } else { nil } }
    }

    // MARK: - Which way she faces

    @Test("走る時間は距離で決まる。同じ足どりなので、短い移動でも走る絵が見える")
    func runDuration() {
        let here = CGPoint(x: 0, y: 0)
        #expect(CharacterRun.duration(from: here, to: CGPoint(x: 220, y: 0)) == 1)
        #expect(CharacterRun.duration(from: here, to: CGPoint(x: 5, y: 0)) == CharacterRun.shortest)
        #expect(CharacterRun.duration(from: here, to: CGPoint(x: 5000, y: 0)) == CharacterRun.longest)
        // 開く・畳むのは走りではないので、距離では決まらない。
        #expect(CardAnimation.duration == 0.25)
    }

    @Test("走る向きは横の動きで決まり、ほぼ真上・真下のときは直前の向きを保つ")
    func facing() {
        let here = CGPoint(x: 100, y: 100)
        #expect(CharacterRun.facing(from: here, to: CGPoint(x: 300, y: 100), keeping: .left) == .right)
        #expect(CharacterRun.facing(from: here, to: CGPoint(x: 10, y: 400), keeping: .right) == .left)
        #expect(CharacterRun.facing(from: here, to: CGPoint(x: 100, y: 400), keeping: .left) == .left)
        #expect(CharacterRun.facing(from: here, to: CGPoint(x: 100, y: 400), keeping: .right) == .right)
    }

    // MARK: - The owner's drag

    @Test("ドラッグの間は進む向きの走る絵にし、手を離したら止まって定位置を覚える")
    func drag() {
        var mediator = self.mediator()
        _ = mediator.handle(.characterDragBegan)
        _ = mediator.handle(.characterFrameChanged(character.offsetBy(dx: 60, dy: 20), visible: screen))
        #expect(mediator.state.motion == .running(.right))
        _ = mediator.handle(.characterFrameChanged(character.offsetBy(dx: -40, dy: 20), visible: screen))
        #expect(mediator.state.motion == .running(.left))

        let ended = mediator.handle(.characterDragEnded)
        #expect(mediator.state.motion == .still)
        #expect(ended.contains(.saveCharacterPlace))
    }

    @Test("走っている途中で掴まれたら、そこで走りをやめてドラッグに譲る")
    func dragWinsOverARun() {
        var mediator = self.mediator()
        #expect(moves(mediator.handle(.pointerCameNear(at: CGPoint(x: 450, y: 350)))).isEmpty == false)

        let grabbed = mediator.handle(.characterDragBegan)
        #expect(grabbed.contains(.stopCharacterMove))
        // 掴まれたら、どいている扱いは終わる。手を離したところが定位置になる。
        #expect(mediator.state.isSteppedAside == false)

        // 途中でやめた移動の完了が後から届いても、ドラッグの走りを止めないし、定位置も書き換えない。
        let stale = mediator.handle(.characterMoveFinished)
        #expect(stale.contains(.saveCharacterPlace) == false)
        #expect(mediator.state.motion == .running(.right))

        _ = mediator.handle(.characterFrameChanged(character.offsetBy(dx: -50, dy: 0), visible: screen))
        #expect(mediator.state.motion == .running(.left))
        #expect(mediator.handle(.characterDragEnded).contains(.saveCharacterPlace))
    }

    @Test("ドラッグの間は、ポインタを見張らない")
    func noDodgeWhileDragging() {
        var mediator = self.mediator()
        #expect(mediator.handle(.characterDragBegan).contains(.watchPointer(near: nil)))
        #expect(moves(mediator.handle(.pointerCameNear(at: CGPoint(x: 450, y: 350)))).isEmpty)
        #expect(mediator.handle(.characterDragEnded).contains(.watchPointer(near: character)))
    }

    // MARK: - The screens

    @Test("画面の構成が変わったら、画面の中へ走って戻る")
    func backOntoTheScreen() {
        var mediator = self.mediator(at: CGRect(x: 1400, y: 300, width: 100, height: 100))
        let smaller = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let effects = mediator.handle(.screenConfigurationChanged(visible: smaller))
        #expect(moves(effects) == [CGPoint(x: 900, y: 300)])
        #expect(mediator.state.motion == .running(.left))

        _ = mediator.handle(.characterFrameChanged(CGRect(x: 900, y: 300, width: 100, height: 100), visible: smaller))
        let finished = mediator.handle(.characterMoveFinished)
        #expect(mediator.state.motion == .still)
        #expect(finished.contains(.saveCharacterPlace))
    }

    @Test("画面の中にいるなら、画面の構成が変わっても動かさない")
    func staysWhenAlreadyOnScreen() {
        var mediator = self.mediator()
        #expect(moves(mediator.handle(.screenConfigurationChanged(visible: screen))).isEmpty)
    }

    // MARK: - Getting out of the pointer's way

    @Test("ポインタが近づいたら少しどき、離れたら元の場所へ走って戻る")
    func dodge() {
        var mediator = self.mediator()
        let away = mediator.handle(.pointerCameNear(at: CGPoint(x: 450, y: 350)))
        #expect(moves(away) == [CGPoint(x: 400 + PointerDodge.hop(for: character.size).width, y: 300)])
        #expect(mediator.state.motion == .running(.right))
        // While she is out of the way, the pointer is watched around the place she comes back to, so that she does
        // not set off again as soon as she lands.
        #expect(mediator.state.watchedPointerRect == character)
        // Her own place is not overwritten while she is away.
        #expect(mediator.handle(.characterMoveFinished).contains(.saveCharacterPlace) == false)

        _ = mediator.handle(.characterFrameChanged(character.offsetBy(dx: 156, dy: 0), visible: screen))
        let back = mediator.handle(.pointerWentAway)
        #expect(moves(back) == [character.origin])
        #expect(mediator.state.motion == .running(.left))
    }

    @Test("会話のウインドウが開いていても、ポインタを見張り、普段どおりどく")
    func dodgesWhileTheConversationIsOpen() {
        var mediator = self.mediator()
        #expect(mediator.handle(.characterClicked).contains(.watchPointer(near: nil)) == false)
        #expect(mediator.state.watchedPointerRect == character)
        #expect(moves(mediator.handle(.pointerCameNear(at: CGPoint(x: 450, y: 350)))).isEmpty == false)
    }

    @Test("どこへどいてもポインタの前から退けないときは、どかない")
    func noRoomToDodge() {
        let tiny = CGRect(x: 0, y: 0, width: 200, height: 200)
        var mediator = self.mediator(at: CGRect(x: 50, y: 50, width: 100, height: 100), visible: tiny)
        #expect(moves(mediator.handle(.pointerCameNear(at: CGPoint(x: 100, y: 100)))).isEmpty)
    }

    @Test("走っている間の動作は、描画パラメータとしてキャラクターに届く")
    func motionIsADrawingParameter() {
        var mediator = self.mediator()
        #expect(UIProps.root(mediator.state, placement: ColumnPlacement(), time: .example).character.motion == .still)
        _ = mediator.handle(.pointerCameNear(at: CGPoint(x: 450, y: 350)))
        #expect(UIProps.root(mediator.state, placement: ColumnPlacement(), time: .example).character.motion == .running(.right))
        _ = mediator.handle(.characterMoveFinished)
        #expect(UIProps.root(mediator.state, placement: ColumnPlacement(), time: .example).character.motion == .still)
    }

    // MARK: - Where she goes

    @Test("どく先は、ポインタから遠ざかる向きへ少しだけ。画面の端までは行かない")
    func dodgeTarget() {
        let hop = PointerDodge.hop(for: character.size)
        #expect(hop.width == character.width + PointerDodge.margin * 2)
        #expect(PointerDodge.target(character: character, pointer: CGPoint(x: 450, y: 350), visible: screen)
            == CGPoint(x: 400 + hop.width, y: 300))
        #expect(PointerDodge.target(character: character, pointer: CGPoint(x: 700, y: 350), visible: screen)
            == CGPoint(x: 400 - hop.width, y: 300))
    }

    @Test("その向きに画面が足りなければ反対へ、横がどちらも駄目なら上下へどく")
    func dodgeTheOtherWay() {
        let hop = PointerDodge.hop(for: character.size)
        // 左の端にいて、ポインタが右寄りに乗っている。左へは行けないので右へ。
        let atLeft = CGRect(x: 0, y: 300, width: 100, height: 100)
        #expect(PointerDodge.target(character: atLeft, pointer: CGPoint(x: 60, y: 350), visible: screen)
            == CGPoint(x: hop.width, y: 300))

        // 右の端にいて、ポインタがすぐ左にいる。右に画面は無く、左へ跳ぶとポインタのほうへ寄るので、上へ。
        let atRight = CGRect(x: 900, y: 300, width: 100, height: 100)
        #expect(PointerDodge.target(character: atRight, pointer: CGPoint(x: 880, y: 350), visible: screen)
            == CGPoint(x: 900, y: 300 + hop.height))

        // 横に余地の無い細い画面では、上下へ。
        let narrow = CGRect(x: 0, y: 0, width: 200, height: 800)
        let inNarrow = CGRect(x: 50, y: 300, width: 100, height: 100)
        #expect(PointerDodge.target(character: inNarrow, pointer: CGPoint(x: 100, y: 350), visible: narrow)
            == CGPoint(x: 50, y: 300 + hop.height))
    }

    @Test("近い・離れたの境は別にし、戻ってすぐまた逃げることのないようにする")
    func hysteresis() {
        #expect(PointerDodge.awayMargin > PointerDodge.margin)
        // 近づいた瞬間には逃げない。素早く押しに行けば、話しかけるほうが先に間に合う長さにする。
        #expect(PointerDodge.linger >= 1)
        #expect(PointerDodge.isNear(CGPoint(x: 510, y: 350), of: character, textScale: 1))
        #expect(PointerDodge.isNear(CGPoint(x: 560, y: 350), of: character, textScale: 1) == false)
        // The same point is not yet "away": she stays where she is until the pointer is well clear.
        #expect(PointerDodge.isAway(CGPoint(x: 560, y: 350), of: character, textScale: 1) == false)
        #expect(PointerDodge.isAway(CGPoint(x: 700, y: 350), of: character, textScale: 1))
    }
}

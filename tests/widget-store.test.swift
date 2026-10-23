import Foundation
var checks = 0
func expect(_ value: Bool, _ name: String) { if !value { fatalError("FAIL: \(name)") }; checks += 1 }
let calendar = Calendar.current
func date(_ hour: Int, _ day: Int = 23) -> Date { calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))! }
func status(_ updates: [String: Any] = [:], _ hour: Int = 9) -> DayStatus {
    var d: [String: Any] = ["s":12,"off":false,"paused":false,"done":false,"fz":2,"xp":0,"goal":50,"reviews":5,"risk":true,"freezeUsed":false]
    updates.forEach { d[$0] = $1 }
    let data = try! JSONSerialization.data(withJSONObject: ["v":2,"at":0,"days":[WidgetStore.dayKey(date(hour)):d]])
    let p = try! JSONDecoder().decode(WidgetStore.Payload.self, from:data)
    return WidgetStore.status(at:date(hour),payload:p)
}
expect(status().scene == .briefing,"morning briefing")
expect(status([:],12).scene == .reviews,"due reviews after noon")
expect(status(["reviews":0],14).scene == .briefing,"no fabricated reviews")
expect(status([:],21).scene == .late,"late risk")
expect(status(["s":0,"risk":false],22).scene == .reviews,"no risk warning without streak")
expect(status(["freezeUsed":true]).scene == .freeze,"freeze used yesterday")
expect(status(["freezeUsed":true],22).scene == .freeze,"freeze warning still visible at night")
expect(status(["freezeUsed":true,"off":true]).scene == .rest,"off day no warning")
expect(status(["freezeUsed":true,"paused":true]).scene == .rest,"pause no warning")
expect(status(["done":true,"xp":50]).scene == .goal,"exact goal")
expect(status(["done":true,"xp":51]).scene == .bonus,"one XP beyond goal")
expect(status(["done":true,"xp":125]).line.contains("250%"),"actual percentage")
expect(status(["done":true,"xp":10000]).xp == 10000,"XP uncapped")
expect(status(["done":true,"xp":20]).scene == .briefing,"practice does not imply goal met")
expect(status(["done":true,"xp":20]).line == "30 XP to your daily goal.","remaining XP")
expect(status(["done":true,"xp":125,"goal":0]).line == "Practice complete.","goal off no target")
for streak in [7,30,100] {
    expect(status(["done":true,"s":streak,"xp":125]).scene == .milestone,"milestone \(streak)")
    expect(status(["done":true,"s":streak,"xp":125]).detail.contains("125 XP"),"milestone keeps XP")
}
expect(status(["s":7]).scene == .briefing,"no milestone replay before practice")
expect(status(["done":true,"freezeUsed":true,"xp":50]).scene == .goal,"practice clears freeze warning")
expect(status(["reviews":1],14).line == "1 review ready.","singular review")
expect(status(["s":-1,"fz":500,"xp":-2,"reviews":-3]).freezes == 3,"bounded freeze count")
expect(status(["s":-1,"xp":-2]).xp == 0,"nonnegative XP")
expect(WidgetStore.status(at:date(9),payload:nil).line == "Open WonkoLingo to begin","missing data")
let legacy = try! JSONDecoder().decode(WidgetStore.Payload.self,from:Data("{\"v\":1,\"at\":0,\"days\":{\"2026-10-23\":{\"s\":3,\"off\":false,\"paused\":false,\"done\":true,\"fz\":1}}}".utf8))
expect(WidgetStore.status(at:date(9),payload:legacy).line == "Practice complete.","old payload compatible")
expect(WidgetStore.status(at:date(9,24),payload:legacy).streak == 0,"stale snapshot cannot leak progress to another date")
for scene in [WidgetScene.briefing,.reviews,.late,.goal,.bonus,.milestone,.freeze] { expect(scene.asset == "scene-\(scene.rawValue)","asset \(scene.rawValue)") }
print("PASS \(checks) native widget checks")

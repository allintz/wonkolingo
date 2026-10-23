import Foundation

// The app writes these snapshots into the app group; the widget never needs account credentials.
enum WidgetStore {
    static let appGroup = "group.com.alexlintz.wonkolingo"
    static let key = "widget"

    struct Day: Decodable {
        let s: Int
        let off: Bool
        let paused: Bool
        let done: Bool
        let fz: Int
        // Optional so an installed widget can read an older app's snapshot after updating.
        let xp: Int?
        let goal: Int?
        let reviews: Int?
        let risk: Bool?
        let freezeUsed: Bool?
    }
    struct Payload: Decodable {
        let v: Int
        let at: Double
        let days: [String: Day]
    }

    static func load() -> Payload? {
        guard let json = UserDefaults(suiteName: appGroup)?.string(forKey: key), let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Payload.self, from: data)
    }

    static func dayKey(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    static func status(at date: Date, payload: Payload? = load()) -> DayStatus {
        guard let day = payload?.days[dayKey(date)] else {
            return DayStatus(streak: 0, done: false, freezes: 0, scene: .briefing, line: "Open WonkoLingo to begin")
        }
        let xp = max(0, day.xp ?? 0), goal = max(0, day.goal ?? 0), reviews = max(0, day.reviews ?? 0)
        func result(_ scene: WidgetScene, _ line: String) -> DayStatus {
            DayStatus(streak: max(0, day.s), done: day.done, freezes: max(0, min(3, day.fz)), scene: scene, line: line, xp: xp, goal: goal, reviews: reviews)
        }
        if day.done {
            if [7, 30, 100].contains(day.s) { return result(.milestone, "\(day.s) days. Well played.") }
            if goal > 0 && xp > goal { return result(.bonus, "\(Int((Double(xp) / Double(goal) * 100).rounded(.down)))% of goal. Still going.") }
            if goal > 0 && xp >= goal { return result(.goal, "Daily goal reached.") }
            if goal > 0 { return result(.briefing, "\(goal - xp) XP to your daily goal.") }
            return result(.goal, "Practice complete.")
        }
        if day.paused { return result(.rest, "Streak paused") }
        if day.off { return result(.rest, "Day off") }
        if day.freezeUsed == true { return result(.freeze, "Freeze used. Practice today.") }
        let hour = Calendar.current.component(.hour, from: date)
        if hour >= 21 && (day.risk ?? (day.s > 0)) { return result(.late, "Still time for a quick round.") }
        if hour >= 12 && reviews > 0 { return result(.reviews, "\(reviews) review\(reviews == 1 ? "" : "s") ready.") }
        return result(.briefing, "Your briefing is ready.")
    }
}

enum WidgetScene: String { case briefing, reviews, late, goal, bonus, milestone, freeze, rest
    var asset: String { self == .rest ? "read" : "scene-\(rawValue)" }
}

struct DayStatus {
    let streak: Int
    let done: Bool
    let freezes: Int
    let scene: WidgetScene
    let line: String
    var xp: Int = 0
    var goal: Int = 0
    var reviews: Int = 0
    var detail: String {
        if scene == .reviews { return "\(reviews) reviews · \(streak)-day streak" }
        if done || xp > 0 { return "\(xp) XP today · \(streak)-day streak" }
        return "\(streak)-day streak"
    }
    static let sample = DayStatus(streak: 12, done: false, freezes: 2, scene: .briefing, line: "Your briefing is ready.")
}

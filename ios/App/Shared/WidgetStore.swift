import Foundation

// Shared by the app (which writes) and the widget (which reads), through the app group.
enum WidgetStore {
    static let appGroup = "group.com.alexlintz.wonkolingo"
    static let key = "widget"

    struct Day: Decodable {
        let s: Int        // streak on that day if no more practice happens
        let off: Bool     // not a counting day, or paused
        let paused: Bool
        let done: Bool    // practiced already (only ever true for the day it was written)
        let fz: Int       // streak freezes saved
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
        let hour = Calendar.current.component(.hour, from: date)
        guard let day = payload?.days[dayKey(date)] else {
            return DayStatus(streak: 0, done: false, freezes: 0, mood: .wave, line: "Open WonkoLingo to start a streak")
        }
        if day.done { return DayStatus(streak: day.s, done: true, freezes: day.fz, mood: .cheer, line: "Done for today") }
        if day.paused { return DayStatus(streak: day.s, done: false, freezes: day.fz, mood: .read, line: "Streak paused") }
        if day.off { return DayStatus(streak: day.s, done: false, freezes: day.fz, mood: .read, line: "Day off") }
        let start = day.s == 0
        switch hour {
        case ..<12: return DayStatus(streak: day.s, done: false, freezes: day.fz, mood: .wave, line: start ? "Start a streak today" : "Ready when you are")
        case ..<17: return DayStatus(streak: day.s, done: false, freezes: day.fz, mood: .think, line: start ? "Start a streak today" : "A few minutes today?")
        case ..<21: return DayStatus(streak: day.s, done: false, freezes: day.fz, mood: .skeptic, line: "Still time today")
        default: return DayStatus(streak: day.s, done: false, freezes: day.fz, mood: .skeptic, line: "Quick round before bed?")
        }
    }
}

enum Mood: String { case cheer, wave, think, skeptic, read }

struct DayStatus {
    let streak: Int
    let done: Bool
    let freezes: Int
    let mood: Mood
    let line: String

    static let sample = DayStatus(streak: 12, done: false, freezes: 2, mood: .think, line: "A few minutes today?")
}

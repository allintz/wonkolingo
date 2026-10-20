import WidgetKit
import SwiftUI

// Streak widget for the home screen and lock screen. The owl's mood follows the day: waving in the morning,
// thinking in the afternoon, skeptical in the evening, cheering once you've practiced, reading on days off.

private let brass = Color(red: 0.910, green: 0.718, blue: 0.353)
private let ink = Color(red: 0.902, green: 0.882, blue: 0.839)
private let muted = Color(red: 0.604, green: 0.643, blue: 0.682)

struct StreakEntry: TimelineEntry {
    let date: Date
    let status: DayStatus
}

struct StreakProvider: TimelineProvider {
    func placeholder(in context: Context) -> StreakEntry { StreakEntry(date: .now, status: .sample) }

    func getSnapshot(in context: Context, completion: @escaping (StreakEntry) -> Void) {
        let payload = WidgetStore.load()
        completion(StreakEntry(date: .now, status: context.isPreview && payload == nil ? .sample : WidgetStore.status(at: .now, payload: payload)))
    }

    // An entry now and at each hour the owl's mood changes, today and tomorrow. The app reloads the timeline
    // whenever progress changes, so a finished session shows right away.
    func getTimeline(in context: Context, completion: @escaping (Timeline<StreakEntry>) -> Void) {
        let cal = Calendar.current, now = Date(), payload = WidgetStore.load()
        var dates = [now]
        for offset in 0...1 {
            guard let day = cal.date(byAdding: .day, value: offset, to: cal.startOfDay(for: now)) else { continue }
            for hour in [0, 12, 17, 21] {
                if let d = cal.date(bySettingHour: hour, minute: 0, second: 0, of: day), d > now { dates.append(d) }
            }
        }
        let entries = dates.sorted().map { StreakEntry(date: $0, status: WidgetStore.status(at: $0, payload: payload)) }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

struct StreakWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: StreakEntry
    var s: DayStatus { entry.status }

    var body: some View {
        switch family {
        case .accessoryCircular: circular
        case .accessoryRectangular: rectangular
        case .accessoryInline: inline
        case .systemMedium: medium
        default: small
        }
    }

    private var flame: some View {
        Image(systemName: "flame.fill").foregroundStyle(s.done ? brass : muted)
    }
    private var days: String { s.streak == 1 ? "day" : "days" }

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        flame.font(.system(size: 20, weight: .bold))
                        Text("\(s.streak)").font(.system(size: 34, weight: .heavy, design: .rounded)).foregroundStyle(ink)
                            .minimumScaleFactor(0.6).lineLimit(1)
                    }
                    Text(days).font(.system(size: 13, weight: .semibold, design: .rounded)).foregroundStyle(muted)
                }
                Spacer(minLength: 4)
                Image(s.mood.rawValue).resizable().scaledToFit().frame(width: 62, height: 62)
            }
            Spacer(minLength: 4)
            Text(s.line).font(.system(size: 14, weight: .bold, design: .rounded)).foregroundStyle(s.done ? brass : ink)
                .lineLimit(2).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) { Color("WidgetBackground") }
    }

    private var medium: some View {
        HStack(spacing: 14) {
            Image(s.mood.rawValue).resizable().scaledToFit().frame(width: 104, height: 104)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    flame.font(.system(size: 24, weight: .bold))
                    Text("\(s.streak)").font(.system(size: 40, weight: .heavy, design: .rounded)).foregroundStyle(ink)
                    Text("\(days) streak").font(.system(size: 15, weight: .semibold, design: .rounded)).foregroundStyle(muted)
                }
                Text(s.line).font(.system(size: 16, weight: .bold, design: .rounded)).foregroundStyle(s.done ? brass : ink).lineLimit(2)
                if s.freezes > 0 {
                    HStack(spacing: 4) {
                        ForEach(0..<s.freezes, id: \.self) { _ in Image(systemName: "snowflake").font(.system(size: 12, weight: .bold)) }
                        Text(s.freezes == 1 ? "1 freeze saved" : "\(s.freezes) freezes saved").font(.system(size: 12, weight: .semibold, design: .rounded))
                    }
                    .foregroundStyle(muted)
                }
            }
            Spacer(minLength: 0)
        }
        .containerBackground(for: .widget) { Color("WidgetBackground") }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -2) {
                Image(systemName: s.done ? "flame.fill" : "flame").font(.system(size: 15, weight: .bold))
                Text("\(s.streak)").font(.system(size: 20, weight: .heavy, design: .rounded))
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Label("\(s.streak)-day streak", systemImage: s.done ? "flame.fill" : "flame")
                .font(.system(size: 15, weight: .bold, design: .rounded))
            Text(s.line).font(.system(size: 13, weight: .medium, design: .rounded)).lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.clear }
    }

    private var inline: some View {
        Label(s.done ? "\(s.streak)-day streak · done" : "\(s.streak)-day streak", systemImage: "flame.fill")
            .containerBackground(for: .widget) { Color.clear }
    }
}

struct StreakWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "StreakWidget", provider: StreakProvider()) { entry in
            StreakWidgetView(entry: entry).widgetURL(URL(string: "wonkolingo://today"))
        }
        .configurationDisplayName("Streak")
        .description("Your streak, whether today’s practice is done, and how the owl feels about it.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

@main
struct WonkoWidgets: WidgetBundle {
    var body: some Widget { StreakWidget() }
}

#Preview(as: .systemSmall) { StreakWidget() } timeline: {
    StreakEntry(date: .now, status: .sample)
    StreakEntry(date: .now, status: DayStatus(streak: 13, done: true, freezes: 2, mood: .cheer, line: "Done for today"))
}

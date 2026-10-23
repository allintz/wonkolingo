import WidgetKit
import SwiftUI
import ImageIO

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
    func getTimeline(in context: Context, completion: @escaping (Timeline<StreakEntry>) -> Void) {
        let cal = Calendar.current, now = Date(), payload = WidgetStore.load()
        var dates = [now]
        for offset in 0...14 {
            guard let day = cal.date(byAdding: .day, value: offset, to: cal.startOfDay(for: now)) else { continue }
            for hour in [0, 12, 21] {
                if let d = cal.date(bySettingHour: hour, minute: 0, second: 0, of: day), d > now { dates.append(d) }
            }
        }
        completion(Timeline(entries: dates.sorted().map { StreakEntry(date: $0, status: WidgetStore.status(at: $0, payload: payload)) }, policy: .atEnd))
    }
}

// Approved still illustrations, with real progress rendered as text instead of baked into the art.
struct StreakWidgetView: View {
    @Environment(\.widgetFamily) var family
    @Environment(\.colorScheme) var colorScheme
    let entry: StreakEntry
    var s: DayStatus { entry.status }
    private var night: Bool { colorScheme == .dark || s.scene == .late }
    private var foreground: Color { night ? Color(red: 0.91, green: 0.89, blue: 0.85) : Color(red: 0.13, green: 0.18, blue: 0.23) }
    private var background: Color { night ? Color(red: 0.055, green: 0.078, blue: 0.106) : Color(red: 0.97, green: 0.95, blue: 0.91) }
    private var detailColor: Color { night ? Color(red: 0.68, green: 0.71, blue: 0.74) : Color(red: 0.35, green: 0.38, blue: 0.41) }

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            case .accessoryInline: inline
            case .systemMedium: medium
            default: small
            }
        }
        .animation(nil, value: s.scene)
    }
    private var owl: some View {
        Group {
            if let image = WidgetArtwork.image(s.scene.asset) {
                Image(decorative: image, scale: 1).resizable().scaledToFit()
            } else {
                Image("read").resizable().scaledToFit()
            }
        }.accessibilityHidden(true)
    }
    private var title: some View {
        Text(s.line).font(.system(size: 15, weight: .bold, design: .rounded))
            .foregroundStyle(foreground).lineLimit(2).minimumScaleFactor(0.8)
    }
    private var small: some View {
        VStack(alignment: .leading, spacing: 3) {
            title.fixedSize(horizontal: false, vertical: true)
            owl.frame(maxWidth: .infinity, maxHeight: .infinity)
            Text(s.detail).font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(detailColor).lineLimit(1).minimumScaleFactor(0.7)
        }
        .containerBackground(for: .widget) { background }
    }
    private var medium: some View {
        HStack(spacing: 12) {
            owl.frame(width: 120)
            VStack(alignment: .leading, spacing: 7) {
                title
                Text(s.done || s.xp > 0 ? "\(s.xp) XP today" : "\(s.streak)-day streak")
                    .font(.system(size: 22, weight: .heavy, design: .rounded)).foregroundStyle(foreground)
                    .lineLimit(1).minimumScaleFactor(0.7)
                if s.done || s.xp > 0 {
                    Text("\(s.streak)-day streak").font(.system(size: 12, weight: .semibold, design: .rounded)).foregroundStyle(detailColor)
                }
                if s.freezes > 0 {
                    Label("\(s.freezes) freeze\(s.freezes == 1 ? "" : "s") saved", systemImage: "snowflake")
                        .font(.system(size: 11, weight: .medium)).foregroundStyle(detailColor)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .containerBackground(for: .widget) { background }
    }
    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -2) {
                Image(systemName: s.scene == .freeze ? "snowflake" : (s.done ? "flame.fill" : "flame"))
                    .font(.system(size: 15, weight: .bold))
                Text("\(s.streak)").font(.system(size: 20, weight: .heavy, design: .rounded))
            }
        }.containerBackground(for: .widget) { Color.clear }
    }
    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(s.detail).font(.system(size: 13, weight: .bold, design: .rounded)).lineLimit(1).minimumScaleFactor(0.7)
            Text(s.line).font(.system(size: 12, weight: .medium, design: .rounded)).lineLimit(2)
        }.frame(maxWidth: .infinity, alignment: .leading)
            .containerBackground(for: .widget) { Color.clear }
    }
    private var inline: some View {
        Text(s.scene == .freeze ? "Freeze used · \(s.streak)-day streak" : s.detail)
            .containerBackground(for: .widget) { Color.clear }
    }
}
// Decode only a widget-sized thumbnail; original artwork stays intact in the bundle.
private enum WidgetArtwork {
    static var cache: [String: CGImage] = [:]
    static func image(_ name: String) -> CGImage? {
        if let image = cache[name] { return image }
        guard let url = Bundle.main.url(forResource: name, withExtension: "png"),
              let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 512,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true
              ] as CFDictionary) else { return nil }
        cache[name] = image
        return image
    }
}

struct StreakWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "StreakWidget", provider: StreakProvider()) { entry in
            StreakWidgetView(entry: entry).widgetURL(URL(string: "wonkolingo://today"))
        }
        .configurationDisplayName("WonkoLingo")
        .description("Your owl, daily XP, reviews and streak.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
@main
struct WonkoWidgets: WidgetBundle {
    var body: some Widget { StreakWidget() }
}
#Preview(as: .systemSmall) { StreakWidget() } timeline: {
    StreakEntry(date: .now, status: .sample)
    StreakEntry(date: .now, status: DayStatus(streak: 13, done: true, freezes: 2, scene: .bonus, line: "250% of goal. Still going.", xp: 125, goal: 50))
    StreakEntry(date: .now, status: DayStatus(streak: 13, done: false, freezes: 1, scene: .freeze, line: "Freeze used. Practice today."))
}

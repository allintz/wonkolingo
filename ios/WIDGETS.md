# Widget stills

Seven original-style owl illustrations approved by Alex on 2026-10-23, replacing the earlier animation concept. Assets live in App/WonkoWidget/Artwork. Original high-resolution PNGs are preserved; ImageIO decodes thumbnails of at most 512px to keep widget memory bounded. No repeating animations.

The app sends a version-2 daily snapshot for 15 local calendar days: streak, practice status, off days, pauses, saved freezes, XP, daily goal, reviews due, streak risk, and whether yesterday consumed a freeze. Older snapshots still decode. Opening the iPhone app picks up practice completed on other devices.

Selection order:

- After practice: a 7-, 30- or 100-day milestone, then bonus XP above the goal, then a reached daily goal. If the goal remains incomplete, show the briefing and remaining XP. With goals off, show Practice complete.
- Before practice: pauses and off days retain the reading owl. Otherwise a consumed freeze shows the snowy shivering owl until practice, followed by a late-night reminder from 9pm if the streak is at risk, reviews due after noon, and the morning briefing.
- Actual XP stays visible with completed practice, including milestones. XP and percentage have no daily-goal cap.

Small and medium home-screen widgets show the art. Lock-screen variants retain compact text and progress. Tapping opens Today. Native tests: tests/widget-store.test.swift. Browser snapshot checks: tests/widget-checks.mjs, included in the full end-to-end suite.

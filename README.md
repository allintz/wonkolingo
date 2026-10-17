# WonkoLingo

A spaced-repetition quiz app for groups of friends, with a Duolingo-style social layer. Every question becomes a card that comes back for review on a schedule (the [FSRS](https://github.com/open-spaced-repetition/fsrs4anki) algorithm with default weights). Reviews ask you to type the answer from memory; Claude Sonnet 5.5 grades it, giving a percent score and a note on each point you made, and the score sets when the card comes back. If you think the grader got it wrong, you can say why and get a second opinion from Claude Opus 5.5; disputes are saved for review. Everyone can write courses (with help from their AI assistant), and the group competes on streaks and XP. It ships with built-in courses, including:

- **Staff Talk:** decoding what Capitol Hill staffers mean ("we're monitoring the issue closely").
- **Procedure:** how bills move through the House and Senate: committees, the Rules Committee, cloture, reconciliation, conference, vetoes and the Congressional Review Act.
- **FRONTIER Act:** how the leading bipartisan House frontier AI bill (H.R. 9925) would work: developer tiers, reporting, licensed outside auditors, emergency orders and state preemption. Also available as a course file in [courses/frontier-act.json](courses/frontier-act.json).

Play it at https://allintz.github.io/wonkolingo/ (also at https://wonkolingo.alex-l-lintz.workers.dev).

It's a single self-contained page (`docs/index.html`). Your own progress is saved in your browser.

## Group play

Start a group or join one with a 6-letter invite code to see everyone's streaks, weekly and all-time XP, and recent lessons, and to challenge each other with "Beat it." There are no passwords: each player gets a random token, shown as a recovery code for moving to another device. Scores are self-reported, so this is for friendly competition only.

## Making your own courses

Anyone in a group can add a course with **+ Add course**. Give your AI assistant the [course format guide](course-guide.md) (also at https://wonkolingo.alex-l-lintz.workers.dev/course-guide.md), upload the `.json` file it produces, and the app checks it before publishing it to your group. Everyone's lessons count toward the same leaderboard. Players can report wrong answers; only the author sees the reports. See [example-course.json](example-course.json) for a small complete course.

Streaks are forgiving: you choose which days count (every day, weekdays or custom), can pause, and earn a streak freeze every 5 practice days (up to 3) that covers a missed day automatically. If you're in a group, progress syncs to the server so it follows you across devices.

The previous lesson-path version is tagged `v1-lesson-path`.

Answer grading needs an `ANTHROPIC_API_KEY` Worker secret (`wrangler secret put ANTHROPIC_API_KEY`); it's capped per player and per day in `src/grade.js`. Without it, players grade themselves. Grading works without joining a group; visitors are capped by a salted hash of their IP. `scripts/disputes.sh` lists disputed grades, and `scripts/grade_one.py --calibration` reruns a set of hand-graded answers (`scripts/calibration.json`) against the current grader prompt; run it before changing the prompt, scoring or model.

The backend is a Cloudflare Worker (`src/worker.js`) with a D1 database (`schema.sql`). The GitHub Pages copy talks to the same API.

## Caveats

The Staff Talk answers are generic rules of thumb from published staffer guides and Hill reporting; they haven't been checked by a Hill staffer. The Procedure answers simplify standard House and Senate procedure and haven't been reviewed by a procedure expert. News examples are paraphrased from 2023 to 2025 coverage.

## Editing

The source lives outside this repo. `build.sh` wraps it into `docs/index.html`; `deploy.sh` rebuilds and deploys the page and API to Cloudflare. For a new database, run `wrangler d1 execute DB --remote --file schema.sql` once. To publish to GitHub Pages, commit and push `docs/`.

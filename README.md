# Hill Speak

A Duolingo-style trainer with two tracks:

- **Staff Talk:** decoding what Capitol Hill staffers mean ("we're monitoring the issue closely").
- **Procedure:** how bills move through the House and Senate: committees, the Rules Committee, cloture, reconciliation, conference, vetoes and the Congressional Review Act.

Play it at https://allintz.github.io/hill-speak/ (also at https://hill-speak.alex-l-lintz.workers.dev).

It's a single self-contained page (`docs/index.html`). Your own progress is saved in your browser.

## Group play

Start a group or join one with a 6-letter invite code to see everyone's streaks, weekly and all-time XP, and recent lessons, and to challenge each other with "Beat it." There are no passwords: each player gets a random token, shown as a recovery code for moving to another device. Scores are self-reported, so this is for friendly competition only.

## Making your own courses

Anyone in a group can add a course with **+ Add course**. Give your AI assistant the [course format guide](course-guide.md) (also at https://hill-speak.alex-l-lintz.workers.dev/course-guide.md), upload the `.json` file it produces, and the app checks it before publishing it to your group. Everyone's lessons count toward the same leaderboard. Players can report wrong answers; only the author sees the reports. See [example-course.json](example-course.json) for a small complete course.

The backend is a Cloudflare Worker (`src/worker.js`) with a D1 database (`schema.sql`). The GitHub Pages copy talks to the same API.

## Caveats

The Staff Talk answers are generic rules of thumb from published staffer guides and Hill reporting; they haven't been checked by a Hill staffer. The Procedure answers simplify standard House and Senate procedure and haven't been reviewed by a procedure expert. News examples are paraphrased from 2023 to 2025 coverage.

## Editing

The source lives outside this repo. `build.sh` wraps it into `docs/index.html`; `deploy.sh` rebuilds and deploys the page and API to Cloudflare. For a new database, run `wrangler d1 execute hill-speak --remote --file schema.sql` once. To publish to GitHub Pages, commit and push `docs/`.

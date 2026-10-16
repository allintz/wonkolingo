# Hill Speak

A Duolingo-style trainer with two tracks:

- **Staff Talk:** decoding what Capitol Hill staffers mean ("we're monitoring the issue closely").
- **Procedure:** how bills move through the House and Senate: committees, the Rules Committee, cloture, reconciliation, conference, vetoes and the Congressional Review Act.

Play it at https://allintz.github.io/hill-speak/ (also at https://hill-speak.alex-l-lintz.workers.dev).

It's a single self-contained page (`docs/index.html`). Progress is saved in your browser only.

## Caveats

The Staff Talk answers are generic rules of thumb from published staffer guides and Hill reporting; they haven't been checked by a Hill staffer. The Procedure answers simplify standard House and Senate procedure and haven't been reviewed by a procedure expert. News examples are paraphrased from 2023 to 2025 coverage.

## Editing

The source lives outside this repo. `build.sh` wraps it into `docs/index.html`; `deploy.sh` rebuilds and deploys to Cloudflare. To publish to GitHub Pages, commit and push `docs/`.

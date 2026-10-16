# Hill Speak course format guide

This guide is written for an AI assistant (such as Claude) that has been asked to build a course for **Hill Speak**, a Duolingo-style quiz app at https://hill-speak.alex-l-lintz.workers.dev. Friends in a group each upload courses, and everyone competes on the XP they earn finishing lessons.

Your job: build one course on the topic the user names, as a single JSON file that follows this guide exactly. The app checks every upload against the rules below and rejects files that break them.

## What makes a good course

1. **Get the facts right.** People will learn from this and compete on it. Research before you write: use web search or the user's sources, and prefer primary sources (statutes, congress.gov, CRS reports, official sites, court opinions) over commentary. If you can't verify a claim, leave it out. Don't invent quotes, numbers, vote counts, dates or headlines.
2. **Teach in the explanation.** Every question has an explanation (`x`) that shows after the player answers, whether they got it right or wrong. It should say why the right answer is right and add one useful fact. One to three sentences.
3. **Make wrong options plausible.** Each wrong option should be something a reasonable beginner might believe. Avoid joke options and "all of the above."
4. **One clearly best answer.** If experts could argue for two options, rewrite the question.
5. **Build up.** Order units from basics to harder material. Each lesson should take two to four minutes: about 4 to 6 questions.
6. **Mix question types.** Use mostly multiple choice, plus some matching and ordering.
7. **Be honest about uncertainty.** Use the course `caveat` to say what the course simplifies, where facts change quickly, and what date the facts are current as of.

The app shuffles answer options, match pairs and ordering steps itself, so write them in any order. For ordering questions, list the steps in the **correct** order.

## File structure

```json
{
  "format": "hill-speak-course/1",
  "id": "state-ai-bills",
  "title": "State AI Bills",
  "description": "What the biggest state AI laws require and who they cover.",
  "caveat": "Facts current as of October 2026. Simplified; check the statute before relying on details.",
  "speakers": {
    "s": { "n": "Sam", "r": "State legislative staffer" }
  },
  "units": [
    {
      "title": "The basics",
      "desc": "What state AI laws try to do.",
      "lessons": [
        { "title": "Who's covered", "items": [ ...questions... ] }
      ]
    }
  ]
}
```

| Field | Rules |
|---|---|
| `format` | Exactly `"hill-speak-course/1"`. |
| `id` | 2 to 40 characters: lowercase letters, numbers, hyphens. Must start with a letter or number. Uploading again with the same `id` replaces your earlier version. |
| `title` | Required, up to 40 characters. Shown as a tab, so keep it short. |
| `description` | Optional, up to 200 characters. |
| `caveat` | Optional, up to 400 characters. Shown beside the course. |
| `speakers` | Optional. Up to 8 characters who "say" quotes. Keys are 1 to 8 lowercase letters. `n` is a name (up to 30 characters), `r` is a role (up to 60). Use fictional people, never real ones. |
| `units` | 1 to 12 units. Each has `title` (up to 60 characters), optional `desc` (up to 200) and `lessons`. |
| `lessons` | 1 to 8 per unit. Each has `title` (up to 60 characters) and `items`. |
| `items` | 2 to 15 questions per lesson, and at most 400 questions in the whole course. |

Keep the whole file under 200 KB. Fields not listed here are ignored.

## Question types

### Multiple choice (`"t": "mc"`)

```json
{
  "t": "mc",
  "p": "How many votes does cloture on a bill usually need?",
  "o": ["60", "51", "67", "50 plus the Vice President"],
  "a": 0,
  "x": "Cloture takes three-fifths of senators duly chosen and sworn, which is 60 when no seats are vacant."
}
```

| Field | Rules |
|---|---|
| `p` | The question, up to 300 characters. Required unless `q` is given. |
| `o` | 2 to 5 options, up to 200 characters each, with no duplicates. 4 is best. |
| `a` | The **0-based position** of the right option in `o` (0 is the first). |
| `x` | Required explanation, up to 700 characters. |
| `q` | Optional quote shown in a speech bubble, up to 300 characters. Use for "what does this phrase mean" questions. Include the quotation marks in the text. |
| `who` | Optional speaker key from `speakers`, used with `q`. |
| `ask` | Optional follow-up question the player could ask in real life, up to 300 characters. |
| `news` | Optional `{ "h": "...", "d": "..." }` card shown above the question: `h` is a **paraphrased** description of a real event (up to 160 characters), and `d` is its date (up to 60). Only for real, verified events. The app labels it "paraphrased." |

### Matching (`"t": "match"`)

```json
{
  "t": "match",
  "p": "Match each term to its meaning.",
  "pairs": [
    ["Markup", "Committee session where members amend and vote on a bill"],
    ["Cloture", "Senate vote to end debate"],
    ["Hold", "A senator's warning they'll object to moving something quickly"]
  ],
  "x": "These come up constantly in floor coverage."
}
```

`pairs` is 3 to 6 `[term, meaning]` pairs. Terms are up to 60 characters and must be unique; meanings are up to 160. `p` (up to 300) and `x` are required.

### Ordering (`"t": "order"`)

```json
{
  "t": "order",
  "p": "Put the cloture process in order.",
  "ends": ["First", "Last"],
  "items": ["A senator files cloture", "One day passes", "Cloture vote", "Up to 30 hours of debate", "Final vote"],
  "x": "Each cloture fight takes days of floor time."
}
```

`items` is 3 to 7 unique steps (up to 160 characters each), listed in the **correct** order. `ends` labels the two ends of the list (up to 30 characters each), such as `["First", "Last"]` or `["Weakest", "Strongest"]`. `p` and `x` are required.

## Before you hand over the file

Check that:

- the file is valid JSON (straight double quotes, no trailing commas, no comments);
- every `a` points at the right option, and the position starts at 0;
- no field is over its length limit, and every lesson has at least 2 questions;
- every `who` matches a key in `speakers`;
- every fact, number and date is one you verified, and every `news` card describes a real event with its real date.

Give the user the finished course as **one `.json` file** named after the `id` (for example `state-ai-bills.json`), with nothing else in the file. Tell them to open Hill Speak, choose **+ Add course**, and upload it. If the app lists problems, it will show them as `units[0].lessons[1].items[2].a: ...` paths; fix exactly those and send a new file.

A complete small example: https://hill-speak.alex-l-lintz.workers.dev/example-course.json

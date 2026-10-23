# WonkoLingo course format guide

This guide is written for an AI assistant (such as Claude) that has been asked to build a course for **WonkoLingo**, a Duolingo-style quiz app at https://wonkolingo.alex-l-lintz.workers.dev. Friends in a group each upload courses, and everyone competes on the XP they earn finishing lessons.

Your job: build one course on the topic the user names, as a single JSON file that follows this guide exactly. The app checks every upload against the rules below and rejects files that break them.

## What makes a good course

1. **Get the facts right.** People will learn from this and compete on it. Research before you write: use web search or the user's sources, and prefer primary sources (statutes, congress.gov, CRS reports, official sites, court opinions) over commentary. If you can't verify a claim, leave it out. Don't invent quotes, numbers, vote counts, dates or headlines.
2. **Teach in the explanation.** Every question has an explanation (`x`) that shows after the player answers, whether they got it right or wrong. It should say why the right answer is right and add one useful fact. One to three sentences.
3. **Make wrong options plausible.** Each wrong option should be something a reasonable beginner might believe. Avoid joke options and "all of the above."
4. **One clearly best answer.** If experts could argue for two options, rewrite the question.
5. **Build up.** Order units from basics to harder material. Each lesson should take two to four minutes: about 4 to 6 questions.
6. **Mix question types.** Use mostly multiple choice, plus about one short-answer (`recall`) question per lesson and some matching and ordering.
7. **Be honest about uncertainty.** Use the course `caveat` to say what the course simplifies, where facts change quickly, and what date the facts are current as of.
8. **Write right answers that stand on their own.** WonkoLingo is a spaced-repetition app, and cards get harder as a player learns them: a new card is asked as multiple choice, a familiar one is recalled from memory and self-rated, and now and then a player types an answer that an AI grader checks against your right option. So the right option must be a complete, correct answer to the question by itself ("60 votes, three-fifths of the Senate"), never "Both A and C" or "None of the above".
9. **Give every short-answer card a multiple-choice version** (`choice`, below), so players can learn it as multiple choice before recalling it from memory.
10. **Give every question an `id`.** It keeps players' review history attached to the right question when you upload a new version that adds, removes or reorders questions.
11. **Explain wrong options when you can.** The optional `ow` field explains why each wrong option is wrong. Players who pick one see that note, which helps undo the pull of a plausible wrong answer.

### Writing questions players can answer well

Players type answers from memory and an AI grader scores them, so how a question is worded decides what a good answer looks like.

- **Don't give the answer away in the setup.** Context in the question should help the player understand it, never answer it. Bad: "A safe harbor shields developers from lawsuits if they meet conditions. How does it improve safety?" (the answer is "it rewards meeting the conditions," which the question already said). Better: "Why do supporters prefer a safe harbor to safety mandates or ordinary lawsuits?"
- **Name exactly what the answer should address.** "Name two policies to address this" is ambiguous when a scenario has several problems in it. Say which one: "...so mistakes or sabotage by the AI could go unnoticed. Name two policies proposed to catch this."
- **Ask for an exact number.** "Name two," never "name one or two" or "what are the objections." The grader gives credit per item, so the player needs to know how many earn full marks. Ask for no more items than the answer lists, and ideally fewer, so players have room to choose.
- **Ask for what's distinctive.** Good questions test what separates this policy or idea from similar ones (why this and not a mandate, what this variant adds), not a restatement of its definition.
- **Teach the ideas, don't test the reading.** A course should teach what's worth knowing from its sources, so players never need to read them. It isn't a reading-comprehension test. Check every question: could someone who understands the topic well, but has never read your source, answer it? If not, rewrite it. Questions that fail: "Report X names three risks; name two." "How does the agenda define pacing?" "Why does IFP think...?" Make the idea the subject and credit the source in the explanation: "Why could automating AI research make it harder to keep AI under control?" Name lessons after topics, not documents. What a law or bill requires, and where real actors stand (who supports or opposes what, and why), are facts about the world, so those questions are fine.
- **Attribute views.** When the answer is an opinion, a framework or an objection, say whose it is ("What do critics say...", "Supporters argue..."). Don't present contested views as facts. Attribution is context for the question; it shouldn't be what the question tests.
- **Write the model answer at the precision you'd give full credit for.** The grader treats the model answer as the bar for "precise," so include the specifics that matter (what a threshold triggers, who checks, who gets the report). Put extra context (consequences, history, related facts) in the explanation `x`, which players see right below the model answer. The grader only grades what the question asks, so extra detail is welcome there and never required.

The app shuffles answer options, match pairs and ordering steps itself, so write them in any order. For ordering questions, list the steps in the **correct** order.

## File structure

```json
{
  "format": "wonkolingo-course/1",
  "id": "state-ai-bills",
  "title": "State AI Bills",
  "description": "What the biggest state AI laws require and who they cover.",
  "level": "intermediate",
  "category": "policy",
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
| `format` | Exactly `"wonkolingo-course/1"`. |
| `id` | 2 to 40 characters: lowercase letters, numbers, hyphens. Must start with a letter or number. Uploading again with the same `id` replaces your earlier version. |
| `title` | Required, up to 40 characters. Shown as a tab, so keep it short. |
| `description` | Optional, up to 200 characters. |
| `caveat` | Optional, up to 400 characters. Shown beside the course. |
| `level` | Optional: `"beginner"` (no background needed), `"intermediate"` (assumes the basics of the field) or `"advanced"` (for people who already work on it). Shown on the course. Intermediate and advanced courses can skip intro material: don't spend cards defining terms the level assumes. |
| `category` | Optional: `"hill"`, `"policy"`, `"tech"`, `"security"`, `"democracy"` or `"other"`. The uploader can change it before publishing. If omitted, the app suggests one from the title and description. |
| `categoryLabel` | Optional, up to 40 characters. A name for an `"other"` category, such as “Economics”. |
| `speakers` | Optional. Up to 8 characters who "say" quotes. Keys are 1 to 8 lowercase letters. `n` is a name (up to 30 characters), `r` is a role (up to 60). Use fictional people, never real ones. |
| `units` | 1 to 12 units. Each has `title` (up to 60 characters), optional `desc` (up to 200) and `lessons`. |
| `lessons` | 1 to 8 per unit. Each has `title` (up to 60 characters) and `items`. |
| `items` | 2 to 15 questions per lesson, and at most 400 questions in the whole course. |
| `id` (on any question) | Optional but recommended: 1 to 40 lowercase letters, numbers or hyphens, unique within the course (for example `"cloture-votes"`). Keep a question's `id` when you edit its wording; give it a new one if it now asks something different. |

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

| `ow` | Optional. A list the same length as `o`, explaining why each option is wrong, with `""` for the right one. Each entry up to 300 characters. |
| `keys` | Optional. 1 to 5 key points (up to 160 characters each) the AI grader should look for when the question comes back as a typed answer. |
| `hint` | Optional. A nudge toward the answer (up to 200 characters) shown when the player taps "Give me a hint". It must not give the answer away. If you leave it out, the app writes one. |
| `predict` | Optional `true`. Shows the question as "Make a prediction" (for example, how a vote or ruling turned out). Use only for real, resolved events, and say in `x` what actually happened. |

### Short answer (`"t": "recall"`)

```json
{
  "t": "recall",
  "p": "Why can a single senator slow down almost any bill?",
  "answer": "Because the Senate runs on unanimous consent, and any one senator can object, forcing slow formal procedure like cloture.",
  "keys": ["unanimous consent", "one objection forces formal procedure"],
  "x": "Most Senate business is scheduled by unanimous consent agreements. An objection means leadership has to use floor time on cloture votes instead."
}
```

Depending on how well they know the card, the player sees its multiple-choice version, recalls the answer in their head and rates themselves, or types an answer that an AI grader scores against `answer` and `keys`. `p` (up to 300 characters), `answer` (up to 400) and `x` are required; `keys` and `hint` work the same as for multiple choice. Ask about something with a clear answer that can be stated in a sentence. "Why" and "what happens when" questions work well; open-ended opinion questions don't.

**Multiple-choice version (`"choice"`).** Add a multiple-choice form of the question for players who are still learning it:

```json
"choice": {
  "p": "Which of these explains why one senator can slow almost any bill?",
  "o": ["Most business needs unanimous consent, so one objection forces slow formal procedure", "Any senator can veto a bill in committee", "Bills need 60 cosponsors to reach the floor", "The majority leader must poll every senator"],
  "a": 0,
  "ow": ["", "Committees vote by majority; no single member has a veto.", "There is no cosponsor threshold for floor action.", "Leaders hotline bills, but no poll is required."]
}
```

`o` (2 to 5 options, 4 is best), `a` (0-based position of the right option) and `ow` (optional, one entry per option) follow the multiple-choice rules above. `p` (optional, up to 300 characters) rewords the question for the choice version, which you need for "name two" questions: ask "Which of these is one policy proposed to address X?" with one right policy and three that address different problems. Keep options similar in length, so the right one doesn't stand out.

**Open questions (`"open": true`).** Some questions have many right answers, like "Name two policies that would reduce this risk." Add `"open": true` and write `answer` as a list of examples ("Examples: A; B; C"). The grader then gives full credit for any specific, correct answer, even one that isn't on your list, and the player sees your list under "Some good answers". Ask for one or two items, never "all of them": nobody can reliably recall a whole list. Opinion questions still don't work, even as open questions.

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

`pairs` is 3 to 6 `[term, meaning]` pairs. Terms are up to 60 characters and meanings up to 160. Every term **and** every meaning must be different from the others in the same question, or players can't tell which one is meant. `p` (up to 300) and `x` are required.

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

`p` must say what is being ordered on its own ("Put the Senate's cloture process in order", not "Put the usual steps in order"): in daily reviews the card shows up without its lesson title. `items` is 3 to 7 unique steps (up to 160 characters each), listed in the **correct** order. `ends` labels the two ends of the list (up to 30 characters each), such as `["First", "Last"]` or `["Weakest", "Strongest"]`. `p` and `x` are required.

## Before you hand over the file

Check that:

- the file is valid JSON (straight double quotes, no trailing commas, no comments);
- every `a` points at the right option, the position starts at 0, and the right option makes sense as a typed answer on its own;
- every `ow` list has exactly one entry per option;
- no field is over its length limit, and every lesson has at least 2 questions;
- every `who` matches a key in `speakers`;
- every question has a unique `id`, and every `recall` question has a `choice` version whose right option is correct on its own;
- every fact, number and date is one you verified, and every `news` card describes a real event with its real date.

Give the user the finished course as **one `.json` file** named after the `id` (for example `state-ai-bills.json`), with nothing else in the file. Tell them to open WonkoLingo, choose **+ Add course**, and upload it. If the app lists problems, it will show them as `units[0].lessons[1].items[2].a: ...` paths; fix exactly those and send a new file.

A complete small example: https://wonkolingo.alex-l-lintz.workers.dev/example-course.json

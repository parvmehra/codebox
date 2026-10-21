# Contests and standings

Contests live in PostgreSQL beside problems and submissions. An admin creates a contest through `POST /api/contests` with a slug, title, description, start and end timestamps, publication setting, and an ordered list of published problems with positive point values. New contests are drafts unless `isPublished` is set to `true`.

Published contests can be listed at `GET /api/contests` and viewed at `GET /api/contests/:slug-or-id`. Joining requires an account. A participant may join before or during a contest, choose a public display name, and submit to an included problem only while the contest is live. The participant's submissions remain ordinary asynchronous submissions; they carry a contest ID so the leaderboard can derive scores from durable results.

## Scoring

- A problem awards its configured points once, when the participant has an accepted submission created during the contest window.
- Additional accepted submissions for the same problem do not add points.
- Failed submissions have no penalty.
- Participants rank by total points, then by the earlier time they reached that score, then by join time.
- The leaderboard is derived from accepted submissions and the contest problem list. There is no separate mutable score table to drift away from execution results.
- A solution submitted before the end may finish after the contest closes and still count. The submission's creation time determines whether it was entered in time.

The leaderboard is public, but account emails and user IDs are never returned. Participants choose a public display name when joining; if they leave it blank, the server assigns a random `Coder-…` name.

## Learning notes

- **Problem solved:** contests group existing published problems into a timed event and show standings without changing the worker or execution architecture.
- **Why PostgreSQL:** contest membership, problem points, and submission ownership have relational constraints; the database can enforce unique membership and problem placement.
- **Data flow:** an admin publishes the contest definition, a user joins, the existing submission API records the contest ID, and the leaderboard sums accepted results for that contest.
- **Important failure cases:** submissions must be rejected outside the live window, for nonparticipants, or for problems outside the set. The server checks all three before creating the durable submission.
- **Interview question — Why calculate standings instead of storing scores?** The accepted submission is the source of truth, so computing from it avoids a second score record that could become inconsistent.
- **Interview question — What happens when execution completes after the deadline?** If the user submitted while the contest was live and the worker later accepts it, that result counts because the durable submission timestamp is within the contest window.

## Admin request example

An admin token can create and publish a contest with a request like:

```json
{
  "slug": "autumn-algorithms",
  "title": "Autumn Algorithms",
  "description": "A short set of array and graph problems.",
  "startAt": "2026-11-01T10:00:00.000Z",
  "endAt": "2026-11-01T12:00:00.000Z",
  "isPublished": true,
  "problems": [{ "problemId": "<published-problem-uuid>", "points": 100 }]
}
```

The UI provides an administrator form at `/admin/contests/new`, lists published contests, lets authenticated users join, links contest problems into the existing editor, and displays standings. There is no contest editing endpoint; create a new draft when an event needs a materially different definition.

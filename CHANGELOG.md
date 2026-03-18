# Changelog

## [0.2.0] - 2026-03-18

### Features

- brainstorm replay from participant getHistory() instead of log file (c826b24)
- implement getHistory() for Gemini and Copilot adapters (e2b4b5a)
- reactive injection on by default + rich wave status header in injections (88669e2)
- swipe-to-accept for prompt suggestions on mobile (79482f0)
- add user feedback signals between brainstorm waves (👍/👎/🎯) (22ff4c4)
- wave quality rubric and automatic reflection on discussion stall (c8fa58d)
- brainstorm setup form — goal, constraints, deliverable type, target audience (6b6d982)
- adaptive synthesis templates per deliverable type (59f54f7)
- version management — VersionBadge, version API, release/upgrade scripts (383c400)
- add per-participant role instructions and auto-role assignment (0af3e3f)
- immediate message POST with priority, remove client-side wait gate (836dedb)
- add message priority support (now/next/later) through full pipeline (2fe3301)

### Refactoring

- compact wave status header — one-liner with response count retained (82c3f4a)
- move Send Now (⚡) from input buttons to queued message pill (fb16d7f)

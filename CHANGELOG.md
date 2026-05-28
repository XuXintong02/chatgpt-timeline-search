# Changelog

## 0.2.0 - 2026-05-28

- Added full ChatGPT conversation history indexing from conversation payloads so long chats can show every user request without manual page scrolling.
- Reworked timeline ordering so user-request indexes stay stable and continuous as virtualized DOM nodes appear.
- Improved jump behavior for long conversations, including virtualized middle and tail messages in 50+ request timelines.
- Stopped automatic indexing from scrolling the page; manual history scanning remains available from the panel.
- Capped collapsed right-side rail markers at 8 sampled positions for dense long conversations.
- Added long-history Chrome E2E coverage for 60 user requests, head/middle/tail jumps, marker caps, and no automatic scroll regressions.

## 0.1.0 - 2026-05-24

- Added a right-side hover timeline for ChatGPT conversations.
- Added in-page search across loaded conversation messages.
- Defaulted timeline results to user messages, with an option to include ChatGPT replies.
- Added accurate jump behavior that targets the user request at the start of each round.
- Added route-change handling so switching conversations rebuilds the index.
- Improved Chinese IME input stability in the search box.
- Added an E2E Chrome test fixture for indexing, filtering, route switching, and jump behavior.

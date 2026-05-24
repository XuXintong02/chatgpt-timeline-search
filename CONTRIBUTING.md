# Contributing

Thanks for helping improve ChatGPT Timeline Search.

## Local Setup

1. Clone the repository.
2. Use Node.js 20 or newer.
3. Run the checks:

```bash
npm test
```

4. Load the repository folder as an unpacked extension in Chrome or Edge.

## Development Notes

- Keep the extension dependency-free unless a dependency clearly improves reliability.
- Do not collect or persist conversation content.
- Prefer stable DOM attributes such as `data-message-author-role` when reading ChatGPT messages.
- Keep UI changes small, unobtrusive, and consistent with ChatGPT's visual style.
- Add or update the E2E fixture when changing indexing, search, route switching, or jump behavior.

## Pull Requests

Please include:

- What changed.
- How you tested it.
- Any known limitations.

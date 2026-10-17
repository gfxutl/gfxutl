# Repository rules

- Always make changes on the `dev` branch. Before editing, switch to `dev` (or create it from the current `main` when bootstrapping the repository).
- Push commits only to `origin/dev`; never push changes directly to `main`. The hourly GitHub Actions promotion workflow is the only mechanism that updates `main` from `dev`.
- Do not add, restore, or run automated tests that use Playwright or Chromium (including Chromium launched through another test runner).
- Validate changes with browser-independent checks such as TypeScript compilation, static analysis, focused unit tests, and production builds.
- Do not commit or push changes unless the user explicitly instructs you to do so.

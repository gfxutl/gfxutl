# Repository rules

- Always make changes on the `main` branch.
- Push commits only to `origin/main`; never push changes directly to `release`. The hourly GitHub Actions promotion workflow is the only mechanism that updates `release` from `main`.
- Do not add, restore, or run automated tests that use Playwright or Chromium (including Chromium launched through another test runner).
- Validate changes with browser-independent checks such as TypeScript compilation, static analysis, focused unit tests, and production builds.
- Do not commit or push changes unless the user explicitly instructs you to do so.

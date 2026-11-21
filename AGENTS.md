# Repository Guidelines

## Project Structure & Module Organization

This local-first HRT tracker uses React, TypeScript, and Vite. `index.tsx` mounts `src/App.tsx`. Screens live in `src/pages/`, shared UI in `src/components/`, state in `src/hooks/` and `src/contexts/`, and API clients in `src/services/`. Pharmacokinetic logic lives in `src/domain/`; `logic.ts` re-exports it for compatibility. `worker.ts` implements the Cloudflare API; `migrations/` contains D1 schema changes. `public/` holds static images, `src-tauri/` the desktop shell, and `docker/` self-hosting support. Tests live in `tests/` and `e2e/`.

## Build, Test, and Development Commands

Use Node.js 22 and npm.

- `npm ci`: install locked dependencies.
- `npm run dev`: start Vite at `http://localhost:3000`.
- `npm run wrangler:migrate:local`: initialize local D1 tables.
- `npm run wrangler:dev`: build and serve the Worker on port 8787; run Vite separately for hot reload.
- `npm run build` / `npm run preview`: produce / preview `dist/`.
- `npm run lint`, `npm run format:check`, `npx tsc --noEmit`: check lint, formatting, and types.
- `python3 scripts/set_version.py --check`: verify version consistency.

## Coding Style & Naming Conventions

Follow Prettier: four-space code indentation, single quotes, trailing commas, and 120-column lines; JSON, YAML, and Markdown use two-space indentation. Use `npm run format` for formatting and ESLint for linting. Match existing PascalCase component filenames and `useSomething.ts` hooks. Put visible strings in `src/i18n/` using `t()`. Read `design/system/README.md` before visual changes and reuse design tokens.

## Testing Guidelines

Run `npm test` for Vitest's Node-based `tests/**/*.test.ts` suite; use `npm run test:watch` during development. Browser tests use Playwright in `e2e/*.spec.ts`: install Chromium with `npm run test:e2e:install`, build, then run `npm run test:e2e`. Add regression coverage for changed behavior. No numeric coverage threshold is configured. Preserve intentional `it.fails` cases until the underlying model gap is fixed.

## Commit & Pull Request Guidelines

Use short, imperative commits; history includes plain descriptions and scoped prefixes such as `docs:` and `feat(opsec):`. Discuss larger changes in an issue first. Branch from `main`, keep PRs focused, and complete the PR template with what changed, why, linked issues, verification results, and screenshots for visible changes. Run CI checks before submission; leave version bumps to maintainers.

## Privacy & Agent Instructions

Read `docs/AI-GUIDE.md` and `CONTRIBUTING.md` before changes. When `.codegraph/` exists, use CodeGraph before code discovery. Keep health data local unless users explicitly opt in; never commit secrets or real medical data. Cite sources for model changes. Add numbered migrations instead of editing shipped ones. Report vulnerabilities through `SECURITY.md`.

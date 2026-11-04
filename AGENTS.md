# Coding instructions

These instructions apply throughout this repository. Keep changes focused, readable,
and appropriate for a small hackathon team.

## Project boundaries

- `backend/app/`: Python API and application logic.
- `frontend/src/`: React and TypeScript source code.
- `backend/tests/` and `frontend/tests/`: tests for their respective applications.
- `backend/app/frontend/`: generated frontend build output, when configured.
- Keep API routes thin; put reusable business logic in backend services.
- Keep pages focused on assembling UI; extract reusable components and hooks when
  they have a clear purpose. Avoid abstractions created for hypothetical reuse.

## Python

- Use Black for formatting and Flake8 for linting. Do not introduce a competing
  formatter or replace these tools without discussing the change.
- Use four-space indentation. Let Black determine wrapping and quote style.
- Use Black's default line length of 88. When configuring Flake8, align its line
  length to 88 and resolve formatter conflicts in shared configuration rather than
  adding repeated inline suppressions.
- Use `snake_case` for functions, variables, and modules; `PascalCase` for classes;
  and `UPPER_SNAKE_CASE` for constants.
- Add type annotations to application function parameters and return values.
- Catch specific exceptions. Do not silently swallow failures or expose internal
  errors and secrets in API responses.
- Validate API input and output with explicit schemas. Enforce authorization on
  the backend even when the frontend hides restricted actions.

## JavaScript, TypeScript, and React

- Prefer TypeScript for new frontend application code and `.tsx` for React UI.
- Use ESLint for code-quality checks, including TypeScript and React Hooks rules,
  and Prettier for formatting. Disable conflicting ESLint formatting rules using
  `eslint-config-prettier` when configuring the tools.
- Use Prettier defaults unless committed project configuration specifies otherwise.
  Do not manually reformat files to a different personal style.
- Use `camelCase` for functions and variables; `PascalCase` for React components,
  types, and interfaces; and names starting with `use` for React hooks.
- Enable TypeScript strict checking when configuring the frontend. Prefer explicit
  types at API and component boundaries; allow inference for obvious local values.
- Avoid `any`; use `unknown` and narrow it when handling untrusted values.
- Use function components. Call hooks only at the top level of components or
  custom hooks, and keep dependency lists accurate.
- Handle loading, empty, success, and error states for asynchronous interactions.
- Use semantic HTML, associated form labels, and accessible interactive controls.
- Keep API calls in the API client or focused hooks rather than scattering URLs
  and request handling across UI components.
- Follow the existing styling approach and reuse UI controls before creating new
  ones. Avoid adding another styling framework for a single feature.

## Documentation and comments

- Follow the structured documentation principles in the
  [Doxygen documentation guide](https://www.doxygen.nl/manual/docblocks.html):
  a short summary followed by useful details about inputs, outputs, and failures.
- For Python, use triple-double-quoted docstrings directly inside the documented
  module, class, or function. For nontrivial callable contracts, use a summary and
  `@param`, `@return`, and `@exception` descriptions where relevant. Actual Doxygen
  extraction and command parsing require a separately configured documentation
  toolchain; these conventions do not imply one is installed.
- For JavaScript and TypeScript, use `/** ... */` JSDoc/TSDoc-style blocks with a
  summary and `@param`, `@returns`, or `@throws` where useful. Do not repeat types
  already declared in TypeScript signatures.
- Document public service functions, important hooks, and surprising behavior.
  Simple UI components and obvious helpers do not need boilerplate comment blocks.
- Explain intent, constraints, and trade-offs rather than narrating each line.
- Update documentation when behavior changes. Remove obsolete commented-out code.

## Dependencies, configuration, and generated files

- Python dependencies belong in `backend/pyproject.toml`; frontend dependencies
  belong in `frontend/package.json`. Root manifests coordinate workspaces and
  shared tooling when configured.
- Use uv for Python. Use the frontend package manager selected by the repository;
  the frontend uses npm; do not maintain competing frontend lockfiles.
- Update lockfiles through their package managers, never by hand.
- Do not hand-edit generated API clients, generated route trees, or frontend build
  output. Change their source and regenerate them using the documented commands.
- Never commit secrets, local `.env` files, `.venv/`, or `node_modules/`. Document
  required configuration using placeholders in `.env.example`.
- Browser-delivered configuration is public. Keep privileged API keys and secrets
  on the backend.

## Verification and editor setup

- Shared repository configuration is authoritative; VS Code extensions are a
  convenience, not a replacement for installed project tools.
- Recommended VS Code extensions: Python, Black Formatter, Flake8, ESLint, and
  Prettier. Use Black for Python and Prettier for supported frontend files, with
  format-on-save enabled. Avoid multiple formatters acting on the same language.
- Once dependencies and configuration exist, run the Python formatting and lint
  checks from `backend/`: `uv run black --check app tests` and
  `uv run flake8 app tests`.
- Configure frontend scripts for formatting checks, linting, type checking, and
  builds; run them using the chosen package manager. Do not assume those scripts
  exist before checking `package.json`.
- Run relevant tests for changed behavior. Prioritize critical user flows,
  validation, authorization, and regressions rather than tests that mirror code.
- Keep formatting changes scoped to the work. Do not disable checks merely to
  make a change pass. Report any checks that could not run and why.
- Do not add CI/CD pipelines unless explicitly requested and permitted by the
  hackathon rules. Running local checks does not require a pipeline.

## Current setup status

The initial manifests and Dockerfile are placeholders. These instructions describe
the intended standards; they do not mean dependencies, scripts, or tool settings
are already configured. Inspect the actual files before running setup commands.

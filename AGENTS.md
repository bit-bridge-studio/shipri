# Project Conventions for Codex

## Operating Mode

- Codex works as an executor by default: implement the requested change, run the relevant checks, and report the result.
- Prefer minimal changes. Fix exactly what is required for the task and avoid opportunistic refactoring.
- If a task is ambiguous, make a reasonable local assumption when safe. Ask only when the answer materially changes architecture, security, dependencies, or user-visible behavior.

## Project Structure

- `client/` contains the React/Vite client.
- `server/` contains the Node.js signaling server.
- `docs/` contains the source of truth for protocol, security, UX, testing, NAT traversal, and deployment decisions.
- `coturn/`, `Caddyfile`, `Dockerfile`, and `docker-compose.yml` are deployment and networking files.

## Commands

Use the scripts defined in each `package.json`.

### Client

- Development: `cd client && npm run dev`
- Build: `cd client && npm run build`
- Preview: `cd client && npm run preview`

### Server

- Start: `cd server && npm start`
- Development: `cd server && npm run dev`

If new scripts are added later, prefer those scripts over ad hoc commands.

## TDD and Verification

- Work in TDD mode.
- Tests are mandatory at the end of every implementation stage.
- If the project lacks the required test infrastructure or `test` script, first propose the testing setup and get approval before adding it.
- New dependencies for test infrastructure require separate approval.
- When code changes are made, run the relevant available checks before finishing. If a check cannot be run, state why.

## Documentation

- Start from `docs/README.md` when a task touches architecture, protocol, security, deployment, networking, testing, or UX. It is the documentation index and cross-document baseline for resolving convention conflicts.
- Documentation updates are mandatory when behavior, protocol, security, deployment, networking, or UX changes.
- Keep the relevant files in `docs/` synchronized with implementation changes.
- Documentation and code comments must be written in English.
- Use TypeScript notation for documentation schemas, protocol contracts, and payload shapes for readability. This is a documentation convention only and does not imply migrating the JavaScript implementation to TypeScript.
- User-facing conversation should use the language the user used.

## Current Knowledge and Context7

- Use MCP Context7 to refresh knowledge about frameworks, languages, libraries, APIs, and standards when documentation accuracy matters or when there is any reasonable risk of outdated information.
- Do not guess API details, framework behavior, security recommendations, or standards from memory when current documentation is needed.
- Prefer primary documentation and project-local conventions over assumptions.

## Security and Privacy

- Do not commit secrets, including `.env` files, tokens, private keys, certificates, credentials, or production secrets.
- Do not log private data such as encryption keys, session tokens, room secrets, file contents, or unnecessary identifying information.
- Do not weaken E2EE, NAT traversal, signaling authentication, CORS, or related security controls without explicit approval.
- Do not add analytics, tracking, third-party SaaS, or external APIs without approval.
- Do not send user file contents to the server unless the project requirements explicitly change away from P2P/E2EE.
- Keep the security and protocol documentation updated when security-relevant behavior changes.
- Add npm dependencies only when they are necessary, maintained, and justified.

## Dependencies

- Ask for approval before adding any new dependency.
- Prefer the existing stack and browser/runtime APIs when they are sufficient.
- Keep dependency additions small and task-focused.

## Frontend

- The frontend uses vanilla React/Vite patterns.
- Do not add UI frameworks, heavy component libraries, or styling frameworks unless explicitly approved.
- Match the existing UI style and keep the app-first experience; do not replace application screens with marketing or landing-page layouts.
- Check responsive behavior when frontend layout changes.

## Backend

- The server is a Node.js ES module application.
- Prefer existing Express and Socket.IO patterns.
- Keep signaling behavior aligned with `docs/signaling_protocol_spec.md`.
- Keep security-sensitive server behavior aligned with `docs/security_e2ee_spec.md` and `docs/security_audit_open_source.md`.

## Deployment and Networking

- Modify Docker, Caddy, and coturn files when the task clearly affects deployment, runtime environment, networking, or NAT traversal.
- Keep deployment changes aligned with `docs/deployment_docker_spec.md` and `docs/nat_traversal_strategy.md`.

## Git

- Do not create commits, branches, tags, or pull requests unless explicitly requested.
- Do not revert user changes unless explicitly requested.
- Treat unrelated worktree changes as user-owned and leave them alone.

## Final Responses

- Keep final responses brief.
- Include what changed, which checks were run, and anything that could not be completed.
- For security, architecture, or deployment tasks, include only the highest-signal context needed to understand the result.

// OpenCode 2 entry point. V2 loads a plugin configured by path only as a
// DIRECTORY, and inside it looks for `server.js` or `index.js` — never at
// package.json `main` — so this file is what makes
// `"plugin": ["file:///path/to/opencode-claude"]` work on V2. OpenCode 1 keeps
// loading opencode-claude.js (or this directory, through `main`); both files
// export the same dual plugin, and ONLY the default.
export { default } from "./dist/index.js";

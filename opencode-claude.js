// Entry point: re-exports the compiled plugin from dist/
// OpenCode's file/package loader resolves this more reliably than dist/index.js directly.
// ONLY the default: it is the dual V1/V2 plugin ({ id, setup, server }), and
// OpenCode 1 runs every exported function as a plugin of its own.
export { default } from "./dist/index.js";

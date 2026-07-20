/**
 * Package version, surfaced in the MCP handshake.
 *
 * Duplicated from package.json rather than imported, because the bundle output
 * moves relative to package.json and a runtime read would be fragile. The pair
 * is pinned together by tests/version.test.ts, which fails on drift.
 */
export const VERSION = '0.1.1';

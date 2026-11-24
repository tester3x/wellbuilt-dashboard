// Enforce AGENTS.md: root rule files are stale compatibility references, not
// release authority. A coordinated rules lane must supply its reviewed config.
// No flag/environment bypass and no API requests or live mutations.
console.error('BLOCKED: default Dashboard rules publication is forbidden. Use the coordinated rules-owner release configuration and compatibility/emulator evidence.');
process.exitCode = 1;

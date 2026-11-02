"use strict";

// Let the real CLI exercise its interactive prompt over test-controlled pipes.
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.stdin.setRawMode = () => process.stdin;
process.stdout.columns = 80;

"use strict";

/**
 * Demo CLI network-API guard, loaded with `node --require` before the CLI.
 *
 * PURPOSE DOCUMENTED FAIL-CLOSED SEMANTICS:
 * - Replaces ordinary Node network APIs in the CLI process with functions
 *   that THROW on any use, so `atomic pay` / `atomic status` / `atomic
 *   enroll` cannot silently reach the network in-process. If it fires, the
 *   CLI surfaces a nonzero exit and the guard marker below appears on stderr.
 * - This is a process-level API guard, NOT an OS airgap: network interfaces
 *   stay enabled, and a native module, subprocess, or kernel API could still
 *   ignore it. The real demo still requires an out-of-band rehearsal with
 *   the network adapters disabled.
 * - child_process and worker_threads are deliberately NOT denied: protecting
 *   the profile on Windows spawns local PowerShell for ACL verification,
 *   which is process control, not networking. Local subprocess networking
 *   is out of scope for this guard (same non-airgap caveat).
 */

const guardError = (api) => {
  throw new Error(`atomic guard: network API '${api}' was called in the offline demo CLI.`);
};

const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const http2 = require("node:http2");
const dns = require("node:dns");
const dgram = require("node:dgram");

net.connect = () => guardError("net.connect");
net.createConnection = () => guardError("net.createConnection");
net.createServer = () => guardError("net.createServer");
net.Socket.prototype.connect = () => guardError("net.Socket.connect");
net.Server.prototype.listen = () => guardError("net.Server.listen");
tls.connect = () => guardError("tls.connect");
tls.createServer = () => guardError("tls.createServer");
http.request = () => guardError("http.request");
http.get = () => guardError("http.get");
https.request = () => guardError("https.request");
https.get = () => guardError("https.get");
http2.connect = () => guardError("http2.connect");
for (const name of Object.keys(dns)) {
  if (name.startsWith("resolve") || name === "lookup" || name === "lookupService" || name === "reverse") {
    dns[name] = () => guardError(`dns.${name}`);
  }
}
for (const name of Object.keys(dns.promises)) {
  if (name.startsWith("resolve") || name === "lookup" || name === "lookupService" || name === "reverse") {
    dns.promises[name] = () => guardError(`dns.promises.${name}`);
  }
}
dns.Resolver = function () { guardError("dns.Resolver"); };
dns.promises.Resolver = function () { guardError("dns.promises.Resolver"); };
dgram.createSocket = () => guardError("dgram.createSocket");
globalThis.fetch = async () => guardError("globalThis.fetch");

Object.defineProperty(globalThis, Symbol.for("atomic-commits.demo-network-guard"), {
  value: true,
  writable: false,
  configurable: false,
});

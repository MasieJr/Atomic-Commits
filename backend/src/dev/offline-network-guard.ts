// Development simulator guard, loaded with node --require before sender code.
// This blocks ordinary Node network/process APIs; it is not an OS sandbox.
const deny = (): never => { throw new Error("Offline sender networking is disabled."); };

const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const http2 = require("node:http2");
const dns = require("node:dns");
const dgram = require("node:dgram");
const children = require("node:child_process");
const workers = require("node:worker_threads");

net.connect = deny;
net.createConnection = deny;
net.createServer = deny;
net.Socket.prototype.connect = deny;
net.Server.prototype.listen = deny;
tls.connect = deny;
tls.createServer = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
http2.connect = deny;
for (const name of Object.keys(dns)) {
  if (name.startsWith("resolve") || name === "lookup" || name === "lookupService" || name === "reverse") dns[name] = deny;
}
for (const name of Object.keys(dns.promises)) {
  if (name.startsWith("resolve") || name === "lookup" || name === "lookupService" || name === "reverse") dns.promises[name] = deny;
}
dns.Resolver = deny;
dns.promises.Resolver = deny;
dgram.createSocket = deny;
children.spawn = deny;
children.exec = deny;
children.execFile = deny;
children.fork = deny;
children.spawnSync = deny;
children.execSync = deny;
children.execFileSync = deny;
workers.Worker = deny;
globalThis.fetch = async () => deny();

Object.defineProperty(globalThis, Symbol.for("atomic-commits.offline-network-guard"), {
  value: true,
  writable: false,
  configurable: false,
});

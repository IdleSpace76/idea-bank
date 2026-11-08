import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { localArguments, localInstance, probeLocal } from "../scripts/local-launch.mjs";

assert.deepEqual(localArguments([]), { port: 3000, open: true });
assert.deepEqual(localArguments(["--port", "3100", "--no-open"]), { port: 3100, open: false });
assert.equal(localArguments(["--port=3101"]).port, 3101);
assert.equal(localArguments(["-p", "3102"]).port, 3102);
for (const args of [["--port"], ["--port", "0"], ["--port", "65536"], ["--port", "3x"], ["--hostname", "0.0.0.0"], ["--inspect"]]) assert.throws(() => localArguments(args));
const root = "D:/fixture application with spaces", id = localInstance(root, {});
assert.equal(id, localInstance(root, { IDEA_BANK_DATA_DIR: "./data" }));
assert.notEqual(id, localInstance(root, { IDEA_BANK_DATA_DIR: "another folder" }));
assert.notEqual(id, localInstance(`${root}/moved`, {}));
let status = { kind: "idea-bank-local", version: 1, instanceId: id };
const server = createServer((request, response) => { assert.equal(request.url, "/api/local/status"); response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(status)); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal(await probeLocal(url, id), "ready");
  status = { ...status, instanceId: "another-directory" }; assert.equal(await probeLocal(url, id), "occupied");
  status = { kind: "cloud-site" }; assert.equal(await probeLocal(url, id), "occupied");
} finally { await new Promise(resolve => server.close(resolve)); }
// A pooled socket may first report a reset after its server closes; that is conservatively occupied.
await probeLocal(url, id);
assert.equal(await probeLocal(url, id), "offline");
const child = spawn(process.execPath, ["scripts/run-local.mjs", "start", "--port", "0"], { windowsHide: true, stdio: "ignore" });
assert.equal(await new Promise(resolve => child.once("exit", resolve)), 1);
console.log("Local launch: port validation, loopback-only options, instance/data-folder identity, occupied ports and process exit codes passed.");

/* runs the subject-finding models off the main thread (each run takes a few seconds) */
const { parentPort, workerData } = require("worker_threads");
const path = require("path"), fs = require("fs");
let ort = null; const sessions = {};
async function session(name) {
  if (!ort) { ort = require(path.join(workerData.dir, "ort.node.min.js")); ort.env.wasm.numThreads = 1; ort.env.wasm.wasmPaths = workerData.dir + path.sep; }
  if (!sessions[name]) sessions[name] = await ort.InferenceSession.create(fs.readFileSync(path.join(workerData.dir, name + ".onnx")), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  return sessions[name];
}
parentPort.on("message", async (m) => {
  try {
    const s = await session(m.model);
    const r = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", m.input, [1, 3, m.size, m.size]) });
    const out = r[s.outputNames[0]].data;
    parentPort.postMessage({ id: m.id, mask: out }, [out.buffer]);
  } catch (e) { parentPort.postMessage({ id: m.id, err: String(e && e.message || e) }); }
});

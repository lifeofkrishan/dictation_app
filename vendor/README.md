# Third-party code kept inside this project

These files are copied here (rather than loaded from another website each time)
so that the app makes no network requests except the one-time model download.

| Folder | What | Version | Licence |
| --- | --- | --- | --- |
| `transformers/` | Transformers.js (`@huggingface/transformers`), browser bundle | 4.3.2 | Apache-2.0 |
| `ort/` | ONNX Runtime Web engine files (`onnxruntime-web`) | 1.31.0-dev.20260914-8d85527a0 | MIT |

To update: `npm install @huggingface/transformers@<version>` in a scratch folder,
then copy `dist/transformers.min.js` and the matching
`onnxruntime-web/dist/ort-wasm-simd-threaded{,.asyncify}.{mjs,wasm}` files here.

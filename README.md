# evm2wasm

Minimal EVM bytecode to WebAssembly compiler.

> [!TIP]
> As stated in the [original code](https://github.com/ewasm/evm2wasm), see [RuneVM](https://github.com/axic/runevm) and [yevm](https://github.com/axic/yevm) for replacement candidates.

## Install

```sh
npm install
```

## CLI

### Produce WASM

```sh
bin/evm2wasm.js 6000 -o out.wasm
bin/evm2wasm.js bytecode.hex -o out.wasm
bin/evm2wasm.js bytecode.bin -o out.wasm
```

To convert from hexadecimal to `.bin`, this one-liner can be useful:

```sh
tr -d '[:space:]' < example.hex | xxd -r -ps > example.bin
```

### Produce WASM and WAT

```sh
bin/evm2wasm.js bytecode.hex -o out.wasm --wat
bin/evm2wasm.js bytecode.hex -o out.wasm --wat myOut.wat
```

When `--wat` is passed without a file, the text output is derived from `-o`; for example `out.wasm` writes `out.wat`.

### Produce WASM and WAST

```sh
bin/evm2wasm.js bytecode.hex -o out.wasm --wast myOut.wast
```

## API

```js
const evm2wasm = require('./index.js')

const wasm = await evm2wasm.evm2wasm(Buffer.from('6000', 'hex'))
const wat = evm2wasm.evm2wat(Buffer.from('6000', 'hex'))
const wast = evm2wasm.evm2wast(Buffer.from('6000', 'hex'))
```


## License

As in the [original code](https://github.com/ewasm/evm2wasm/blob/master/LICENSE), this patch is redistributed under the [MPL-2.0](https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)) license.

> [!CAUTION]
> This repository is no longer maintained. The fork exists solely to enable compatibility with newer versions of wabt in 2026. Use this fork only if you need evm2wasm to work with the latest wabt releases; no further updates or support are planned.

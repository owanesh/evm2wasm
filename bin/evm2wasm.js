#!/usr/bin/env node

const evm2wasm = require('../index.js')
const argv = require('minimist')(process.argv.slice(2))
const fs = require('fs')
var tou8 = require('buffer-to-uint8array')

function conversionOptions (opts) {
  return {
    stackTrace: opts.trace,
    tempName: 'temp',
    inlineOps: true,
    chargePerOp: opts.chargePerOp
  }
}

// convert evm bytecode to WASM or WAT/WAST
function convert (bytecode, opts) {
  return new Promise((resolve, reject) => {
    if (!bytecode) {
      return resolve(Buffer.from(''))
    }

    if (opts.textOnly) {
      let output = evm2wasm.evm2wat(bytecode, conversionOptions(opts))
      resolve(output)
    } else {
      evm2wasm.evm2wasm(bytecode, conversionOptions(opts)).then(function (output) {
        // output is a node buffer. convert to Uint8Array
        let outputUint8 = {}
        outputUint8.buffer = tou8(output)
        resolve(outputUint8)
      }).catch(function (err) {
        reject(err)
      })
    }
  })
}

function convertText (bytecode, opts) {
  if (!bytecode) {
    return ''
  }

  return evm2wasm.evm2wat(bytecode, conversionOptions(opts))
}

function storeOrPrintResult (output, outputFile) {
  if (typeof output !== 'string') {
    output = output.buffer
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, output)
  } else {
    console.log(Buffer.from(output).toString('binary'))
  }
}

function decodeBytecode (input, fromFile) {
  if (fromFile) {
    const text = input.toString().trim()
    const hex = text.replace(/^0x/i, '').replace(/\s+/g, '')

    if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex)) {
      return Buffer.from(hex, 'hex')
    }

    return input
  }

  const hex = input.replace(/^0x/i, '').replace(/\s+/g, '')

  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('input is not a file and is not valid hex bytecode')
  }

  return Buffer.from(hex, 'hex')
}

function defaultTextOutputFile (outputFile, extension) {
  if (!outputFile) {
    return undefined
  }

  return outputFile.replace(/\.[^./\\]+$/, '') + '.' + extension
}

const outputFile = argv.o ? argv.o : undefined
const textOutputFile = typeof argv.wat === 'string'
  ? argv.wat
  : argv.wat === true
    ? defaultTextOutputFile(outputFile, 'wat')
    : typeof argv.wast === 'string' ? argv.wast : undefined
const textOnly = argv.wast === true && argv.wat === undefined
const trace = argv.trace !== undefined
const inputFile = argv.e ? argv.e : undefined
const chargePerOp = argv['charge-per-op'] ? argv['charge-per-op'] : undefined

let bytecode

try {
  if (argv.wat === true && !textOutputFile) {
    throw new Error('--wat requires -o or an explicit output file')
  }

  const positionalInput = argv._.length > 0 ? argv._[0].toString() : undefined
  const input = inputFile || positionalInput

  if (!input) {
    throw new Error('must provide evm bytecode file or supply bytecode as a non-named argument')
  }

  if (inputFile || fs.existsSync(input)) {
    bytecode = decodeBytecode(fs.readFileSync(input), true)
  } else {
    // ensure it is a string even it was passed as a number
    bytecode = decodeBytecode(input, false)
  }

  if (textOutputFile) {
    fs.writeFileSync(textOutputFile, convertText(bytecode, { trace: trace, chargePerOp: chargePerOp }))
  }

  convert(bytecode, { textOnly: textOnly, trace: trace, chargePerOp: chargePerOp }).then((result) => {
    storeOrPrintResult(result, outputFile)
  }).catch((err) => {
    // Separately handle async promise errors here so they're not swallowed silently
    console.error('Error:' + err)
    process.exit(1)
  })
} catch (err) {
  console.error('Error: ' + err)
  process.exit(1)
}

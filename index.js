const BN = require('bn.js')
const ethUtil = require('ethereumjs-util')
const opcodes = require('./opcodes.js')
const wastSyncInterface = require('./wasm/wast.json')
const wastAsyncInterface = require('./wasm/wast-async.json')
const wabtFactory = require('wabt')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

let wabtModule

function getWabt () {
  if (wabtModule) {
    return Promise.resolve(wabtModule)
  }

  if (typeof wabtFactory.parseWat === 'function') {
    wabtModule = wabtFactory
    return Promise.resolve(wabtModule)
  }

  const factory = wabtFactory.default || wabtFactory
  const result = factory()

  if (result && typeof result.then === 'function') {
    return result.then((module) => {
      wabtModule = module
      return wabtModule
    })
  }

  wabtModule = result
  return Promise.resolve(wabtModule)
}

function readExpressionEnd (wat, start) {
  let depth = 0

  for (let i = start; i < wat.length; i++) {
    if (wat[i] === '(') {
      depth++
    } else if (wat[i] === ')') {
      depth--
      if (depth === 0) {
        return i + 1
      }
    }
  }

  return start
}

function skipWhitespace (wat, start) {
  let i = start
  while (i < wat.length) {
    if (/\s/.test(wat[i])) {
      i++
    } else if (wat.slice(i, i + 2) === ';;') {
      const newline = wat.indexOf('\n', i)
      i = newline === -1 ? wat.length : newline + 1
    } else {
      break
    }
  }
  return i
}

function splitTopLevelExpressions (wat) {
  const expressions = []
  let i = skipWhitespace(wat, 0)

  while (i < wat.length) {
    if (wat[i] !== '(') {
      break
    }

    const end = readExpressionEnd(wat, i)
    expressions.push(wat.slice(i, end))
    i = skipWhitespace(wat, end)
  }

  return expressions
}

function wrapLegacyIfs (wat) {
  let output = ''

  for (let i = 0; i < wat.length; i++) {
    if (wat.slice(i, i + 3) === '(if' && /\s/.test(wat[i + 3] || '')) {
      const ifEnd = readExpressionEnd(wat, i)
      let conditionStart = skipWhitespace(wat, i + 3)
      let resultExpr = ''

      if (wat.slice(conditionStart, conditionStart + 7) === '(result') {
        const resultEnd = readExpressionEnd(wat, conditionStart)
        resultExpr = wat.slice(conditionStart, resultEnd)
        conditionStart = skipWhitespace(wat, resultEnd)
      }

      const conditionEnd = readExpressionEnd(wat, conditionStart)
      const bodyStart = skipWhitespace(wat, conditionEnd)
      const body = wat.slice(bodyStart, ifEnd - 1)

      if (wat.slice(bodyStart, bodyStart + 5) !== '(then' && wat.slice(bodyStart, bodyStart + 5) !== '(else' && wat[bodyStart] === '(') {
        if (resultExpr) {
          const branches = splitTopLevelExpressions(body)
          output += '(if ' + resultExpr + ' ' + wat.slice(conditionStart, conditionEnd) + ' (then ' + wrapLegacyIfs(branches[0] || '') + ')'
          if (branches[1]) {
            output += ' (else ' + wrapLegacyIfs(branches.slice(1).join(' ')) + ')'
          }
          output += ')'
        } else {
          output += wat.slice(i, bodyStart) + '(then ' + wrapLegacyIfs(body) + '))'
        }
        i = ifEnd - 1
        continue
      }
    }

    output += wat[i]
  }

  return output
}

function normalizeWat (wat) {
  wat = wat
    .replace(/\((get|set|tee)_(local|global)\b/g, (match, op, scope) => {
      return '(' + scope + '.' + op
    })
    .replace(/\bi(32|64)\.extend_([su])\/i(32|64)\b/g, (match, target, sign, source) => {
      return 'i' + target + '.extend_i' + source + '_' + sign
    })
    .replace(/\bi(32|64)\.wrap\/i(32|64)\b/g, (match, target, source) => {
      return 'i' + target + '.wrap_i' + source
    })
    .replace(/\bcurrent_memory\b/g, 'memory.size')
    .replace(/\bgrow_memory\b/g, 'memory.grow')

  return wrapLegacyIfs(wat)
}

function compileWatWithWabtCli (wat) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evm2wasm-'))
  const watFile = path.join(tmpDir, 'module.wat')
  const wasmFile = path.join(tmpDir, 'module.wasm')
  const wat2wasm = [
    '/opt/homebrew/bin/wat2wasm',
    '/usr/local/bin/wat2wasm',
    '/usr/bin/wat2wasm',
    'wat2wasm'
  ].find((candidate) => candidate === 'wat2wasm' || fs.existsSync(candidate))

  try {
    fs.writeFileSync(watFile, wat)
    childProcess.execFileSync(wat2wasm, [watFile, '-o', wasmFile], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return fs.readFileSync(wasmFile)
  } finally {
    try {
      fs.unlinkSync(watFile)
    } catch (err) {}
    try {
      fs.unlinkSync(wasmFile)
    } catch (err) {}
    try {
      fs.rmdirSync(tmpDir)
    } catch (err) {}
  }
}

// map to track dependent WASM functions
const depMap = new Map([
  ['callback_256', ['bswap_m256']],
  ['callback_160', ['bswap_m160']],
  ['callback_128', ['bswap_m128']],
  ['bswap_m256', ['bswap_i64']],
  ['bswap_m128', ['bswap_i64']],
  ['bswap_m160', ['bswap_i64', 'bswap_i32']],
  ['keccak', ['memcpy', 'memset']],
  ['mod_320', ['iszero_320', 'gte_320']],
  ['mod_512', ['iszero_512', 'gte_512']],
  ['MOD', ['iszero_256', 'gte_256']],
  ['ADDMOD', ['mod_320']],
  ['MULMOD', ['mod_512']],
  ['SDIV', ['iszero_256', 'gte_256']],
  ['SMOD', ['iszero_256', 'gte_256']],
  ['DIV', ['iszero_256', 'gte_256']],
  ['EXP', ['iszero_256', 'mul_256']],
  ['MUL', ['mul_256']],
  ['ISZERO', ['iszero_256']],
  ['MSTORE', ['memusegas', 'bswap_m256', 'check_overflow']],
  ['MLOAD', ['memusegas', 'bswap_m256', 'check_overflow']],
  ['MSTORE8', ['memusegas', 'check_overflow']],
  ['CODECOPY', ['callback', 'memusegas', 'check_overflow', 'memset']],
  ['CALLDATALOAD', ['bswap_m256', 'bswap_i64', 'check_overflow']],
  ['CALLDATACOPY', ['memusegas', 'check_overflow', 'memset']],
  ['CALLVALUE', ['bswap_m128']],
  ['EXTCODECOPY', ['bswap_m160', 'callback', 'memusegas', 'check_overflow', 'memset']],
  ['EXTCODESIZE', ['bswap_m160', 'callback_32']],
  ['RETURNDATACOPY', ['memusegas', 'check_overflow', 'memset']],
  ['LOG', ['memusegas', 'check_overflow']],
  ['BLOCKHASH', ['check_overflow', 'callback_256']],
  ['SHA3', ['memusegas', 'bswap_m256', 'check_overflow', 'keccak']],
  ['CALL', ['bswap_m160', 'bswap_m256', 'memusegas', 'check_overflow_i64', 'check_overflow', 'memset', 'callback_32']],
  ['DELEGATECALL', ['bswap_m160', 'callback', 'memusegas', 'check_overflow_i64', 'check_overflow', 'memset', 'callback_32']],
  ['STATICCALL', ['bswap_m160', 'callback', 'memusegas', 'check_overflow_i64', 'check_overflow', 'memset', 'callback_32']],
  ['CALLCODE', ['bswap_m160', 'bswap_m256', 'callback', 'memusegas', 'check_overflow_i64', 'check_overflow', 'check_overflow_i64', 'memset', 'callback_32']],
  ['CREATE', ['bswap_m256', 'bswap_m160', 'callback_160', 'memusegas', 'check_overflow']],
  ['RETURN', ['memusegas', 'check_overflow']],
  ['REVERT', ['memusegas', 'check_overflow']],
  ['BALANCE', ['bswap_m160', 'callback_128']],
  ['SELFDESTRUCT', ['bswap_m160']],
  ['SSTORE', ['bswap_m256', 'callback']],
  ['SLOAD', ['bswap_m256', 'callback_256']],
  ['CODESIZE', ['callback_32']],
  ['DIFFICULTY', ['bswap_m160']],
  ['COINBASE', ['bswap_m160']],
  ['ORIGIN', ['bswap_m160']],
  ['ADDRESS', ['bswap_m160']],
  ['CALLER', ['bswap_m160']]
])

// maps the async ops to their call back function
const callbackFuncs = new Map([
  ['SSTORE', '$callback'],
  ['SLOAD', '$callback_256'],
  ['CREATE', '$callback_160'],
  ['CALL', '$callback_32'],
  ['DELEGATECALL', '$callback'],
  ['CALLCODE', '$callback_32'],
  ['EXTCODECOPY', '$callback'],
  ['EXTCODESIZE', '$callback_32'],
  ['CODECOPY', '$callback'],
  ['CODESIZE', '$callback_32'],
  ['BALANCE', '$callback_128'],
  ['BLOCKHASH', '$callback_256']
])

/**
 * compiles evmCode to wasm in the binary format
 * @param {Array} evmCode
 * @param {Object} opts
 * @param {boolean} opts.stackTrace if `true` generates an runtime EVM stack trace (default: false)
 * @param {boolean} opts.inlineOps if `true` inlines the EVM1 operations (default: true)
 * @param {String} opts.testName is the name used for the wast file (default: 'temp')
 * @param {boolean} opts.chargePerOp if `true` adds metering statements for the wasm code section corresponding to each EVM opcode as opposed to metering once per branch segment (default: false).
 * @return {string}
 */
exports.evm2wasm = function (evmCode, opts = {
  'stackTrace': false,
  'useAsyncAPI': false,
  'inlineOps': true,
  'testName': 'temp',
  'chargePerOp': false
}) {
  const wast = normalizeWat(exports.evm2wast(evmCode, opts))
  return getWabt().then((wabt) => {
    let mod
    try {
      mod = wabt.parseWat('arbitraryModuleName', wast)
      mod.resolveNames()
      mod.validate()
      return mod.toBinary({log: false, write_debug_names: false}).buffer
    } catch (err) {
      if (err && err.name === 'RuntimeError' && /memory access out of bounds/.test(err.message || '')) {
        return compileWatWithWabtCli(wast)
      }
      throw err
    } finally {
      if (mod) {
        mod.destroy()
      }
    }
  })
}

/**
 * Transcompiles EVM code to normalized WebAssembly text format.
 * @param {Integer} evmCode the evm byte code
 * @param {Object} opts
 * @return {string}
 */
exports.evm2wat = function (evmCode, opts = {
  'stackTrace': false,
  'useAsyncAPI': false,
  'inlineOps': true,
  'chargePerOp': false
}) {
  return normalizeWat(exports.evm2wast(evmCode, opts))
}

/**
 * Transcompiles EVM code to ewasm in the sexpression text format. The EVM code
 * is broken into segments and each instruction in those segments is replaced
 * with a `call` to wasm function that does the equivalent operation. Each
 * opcode function takes in and returns the stack pointer.
 *
 * Segments are sections of EVM code in between flow control
 * opcodes (JUMPI. JUMP).
 * All segments start at
 * * the beginning for EVM code
 * * a GAS opcode
 * * a JUMPDEST opcode
 * * After a JUMPI opcode
 * @param {Integer} evmCode the evm byte code
 * @param {Object} opts
 * @param {boolean} opts.stackTrace if `true` generates a stack trace (default: false)
 * @param {boolean} opts.inlineOps if `true` inlines the EVM1 operations (default: true)
 * @param {boolean} opts.chargePerOp if `true` adds metering statements for the wasm code section corresponding to each EVM opcode as opposed to metering once per branch segment (default: false).
 * @return {string}
 */
exports.evm2wast = function (evmCode, opts = {
  'stackTrace': false,
  'useAsyncAPI': false,
  'inlineOps': true,
  'chargePerOp': false
}) {
  // adds stack height checks to the beginning of a segment
  function addStackCheck () {
    let check = ''
    if (segmentStackHigh !== 0) {
      check = `(if (i32.gt_s (get_global $sp) (i32.const ${(1023 - segmentStackHigh) * 32})) 
                 (then (unreachable)))`
    }
    if (segmentStackLow !== 0) {
      check += `(if (i32.lt_s (get_global $sp) (i32.const ${-segmentStackLow * 32 - 32})) 
                  (then (unreachable)))`
    }
    segment = check + segment
    segmentStackHigh = 0
    segmentStackLow = 0
    segmentStackDelta = 0
  }

  // add a metering statment at the beginning of a segment
  function addMetering () {
    if (!opts.chargePerOp) {
      if (gasCount !== 0) {
        wast += `(call $useGas (i64.const ${gasCount})) `
      }
    }

    wast += segment
    segment = ''
    gasCount = 0
  }

  // finishes off a segment
  function endSegment () {
    segment += ')'
    addStackCheck()
    addMetering()
  }
  // this keep track of the opcode we have found so far. This will be used to
  // to figure out what .wast files to include
  const opcodesUsed = new Set()
  const ignoredOps = new Set(['JUMP', 'JUMPI', 'JUMPDEST', 'POP', 'STOP', 'INVALID'])
  let callbackTable = []

  // an array of found segments
  const jumpSegments = []
  // the transcompiled EVM code
  let wast = ''
  let segment = ''
  // keeps track of the gas that each section uses
  let gasCount = 0
  // used for pruning dead code
  let jumpFound = false
  // the accumlitive stack difference for the current segmnet
  let segmentStackDelta = 0
  let segmentStackHigh = 0
  let segmentStackLow = 0

  for (let pc = 0; pc < evmCode.length; pc++) {
    const opint = evmCode[pc]
    const op = opcodes(opint)

    // creates a stack trace
    if (opts.stackTrace) {
      segment += `(call $stackTrace (i32.const ${pc}) (i32.const ${opint}) (i32.const ${op.fee}) (get_global $sp))\n`
    }

    let bytes
    if (opts.chargePerOp) {
      if (op.fee !== 0) {
        segment += `(call $useGas (i64.const ${op.fee})) `
      }
    }
    // do not charge gas for interface methods
    // TODO: implement proper gas charging and enable this here
    if (opint < 0x30 || (opint > 0x45 && opint < 0xa0)) {
      gasCount += op.fee
    }

    segmentStackDelta += op.on
    if (segmentStackDelta > segmentStackHigh) {
      segmentStackHigh = segmentStackDelta
    }

    segmentStackDelta -= op.off
    if (segmentStackDelta < segmentStackLow) {
      segmentStackLow = segmentStackDelta
    }

    switch (op.name) {
      case 'JUMP':
        jumpFound = true
        segment += `;; jump
                      (set_local $jump_dest (call $check_overflow 
                                             (i64.load (get_global $sp))
                                             (i64.load (i32.add (get_global $sp) (i32.const 8)))
                                             (i64.load (i32.add (get_global $sp) (i32.const 16)))
                                             (i64.load (i32.add (get_global $sp) (i32.const 24)))))
                      (set_global $sp (i32.sub (get_global $sp) (i32.const 32)))
                      (br $loop)`
        opcodesUsed.add('check_overflow')
        pc = findNextJumpDest(evmCode, pc)
        break
      case 'JUMPI':
        jumpFound = true
        segment += `(set_local $jump_dest (call $check_overflow 
                                             (i64.load (get_global $sp))
                                             (i64.load (i32.add (get_global $sp) (i32.const 8)))
                                             (i64.load (i32.add (get_global $sp) (i32.const 16)))
                                             (i64.load (i32.add (get_global $sp) (i32.const 24)))))

                    (set_global $sp (i32.sub (get_global $sp) (i32.const 64)))
                    (br_if $loop (i32.eqz (i64.eqz (i64.or
                      (i64.load (i32.add (get_global $sp) (i32.const 32)))
                      (i64.or
                        (i64.load (i32.add (get_global $sp) (i32.const 40)))
                        (i64.or
                          (i64.load (i32.add (get_global $sp) (i32.const 48)))
                          (i64.load (i32.add (get_global $sp) (i32.const 56)))
                        )
                      )
                    ))))\n`
        opcodesUsed.add('check_overflow')
        addStackCheck()
        addMetering()
        break
      case 'JUMPDEST':
        endSegment()
        jumpSegments.push({
          number: pc,
          type: 'jump_dest'
        })
        gasCount = 1
        break
      case 'GAS':
        segment += `(call $GAS)\n`
        // addMetering() // this causes an unreachable error in stackOverflowM1 -d 14
        break
      case 'LOG':
        segment += `(call $LOG (i32.const ${op.number}))\n`
        break
      case 'DUP':
      case 'SWAP':
        // adds the number on the stack to SWAP
        segment += `(call $${op.name} (i32.const ${op.number - 1}))\n`
        break
      case 'PC':
        segment += `(call $PC (i32.const ${pc}))\n`
        break
      case 'PUSH':
        pc++
        bytes = ethUtil.setLength(evmCode.slice(pc, pc += op.number), 32)
        const bytesRounded = Math.ceil(op.number / 8)
        let push = ''
        let q = 0
        // pad the remaining of the word with 0
        for (; q < 4 - bytesRounded; q++) {
          push = '(i64.const 0)' + push
        }

        for (; q < 4; q++) {
          const int64 = bytes2int64(bytes.slice(q * 8, q * 8 + 8))
          push = push + `(i64.const ${int64})`
        }

        segment += `(call $PUSH ${push})`
        pc--
        break
      case 'POP':
        // do nothing
        break
      case 'STOP':
        segment += '(br $done)'
        if (jumpFound) {
          pc = findNextJumpDest(evmCode, pc)
        } else {
          // the rest is dead code
          pc = evmCode.length
        }
        break
      case 'SELFDESTRUCT':
      case 'RETURN':
      case 'REVERT':
        segment += `(call $${op.name}) (br $done)\n`
        if (jumpFound) {
          pc = findNextJumpDest(evmCode, pc)
        } else {
          // the rest is dead code
          pc = evmCode.length
        }
        break
      case 'INVALID':
        segment = '(unreachable)'
        pc = findNextJumpDest(evmCode, pc)
        break
      default:
        if (opts.useAsyncAPI && callbackFuncs.has(op.name)) {
          const cbFunc = callbackFuncs.get(op.name)
          let index = callbackTable.indexOf(cbFunc)
          if (index === -1) {
            index = callbackTable.push(cbFunc) - 1
          }
          segment += `(call $${op.name} (i32.const ${index}))\n`
        } else {
          // use synchronous API
          segment += `(call $${op.name})\n`
        }
    }

    if (!ignoredOps.has(op.name)) {
      opcodesUsed.add(op.name)
    }

    const stackDelta = op.on - op.off
    // update the stack pointer
    if (stackDelta !== 0) {
      segment += `(set_global $sp (i32.add (get_global $sp) (i32.const ${stackDelta * 32})))\n`
    }

    // adds the logic to save the stack pointer before exiting to wiat to for a callback
    // note, this must be done before the sp is updated above^
    if (opts.useAsyncAPI && callbackFuncs.has(op.name)) {
      segment += `(set_global $cb_dest (i32.const ${jumpSegments.length + 1}))
          (br $done))`
      jumpSegments.push({
        type: 'cb_dest'
      })
    }
  }

  endSegment()

  wast = assembleSegments(jumpSegments) + wast + '))'

  let wastFiles = wastSyncInterface // default to synchronous interface
  if (opts.useAsyncAPI) {
    wastFiles = wastAsyncInterface
  }

  let imports = []
  let funcs = []
  // inline EVM opcode implemention
  if (opts.inlineOps) {
    [funcs, imports] = exports.resolveFunctions(opcodesUsed, wastFiles)
  }

  // import stack trace function
  if (opts.stackTrace) {
    imports.push('(import "debug" "printMemHex" (func $printMem (param i32 i32)))')
    imports.push('(import "debug" "print" (func $print (param i32)))')
    imports.push('(import "debug" "evmTrace" (func $stackTrace (param i32 i32 i32 i32)))')
  }
  imports.push('(import "ethereum" "useGas" (func $useGas (param i64)))')

  funcs.push(wast)
  wast = exports.buildModule(funcs, imports, callbackTable)
  return wast
}

// given an array for segments builds a wasm module from those segments
// @param {Array} segments
// @return {String}
function assembleSegments (segments) {
  let wasm = buildJumpMap(segments)

  segments.forEach((seg, index) => {
    wasm = `(block $${index + 1} ${wasm}`
  })

  return `
  (func $main
    (export "main")
    (local $jump_dest i32) (local $jump_map_switch i32)
    (set_local $jump_dest (i32.const -1))

    (block $done
      (loop $loop
        ${wasm}`
}

// Builds the Jump map, which maps EVM jump location to a block label
// @param {Array} segments
// @return {String}
function buildJumpMap (segments) {
  let wasm = '(unreachable)'

  let brTable = ''
  segments.forEach((seg, index) => {
    brTable += ' $' + (index + 1)
    if (seg.type === 'jump_dest') {
      wasm = `(if (i32.eq (get_local $jump_dest) (i32.const ${seg.number}))
                (then (br $${index + 1}))
                (else ${wasm}))`
    }
  })

  wasm = `
  (block $0 
    (if
      (i32.eqz (get_global $init))
      (then
        (set_global $init (i32.const 1))
        (br $0))
      (else
        ;; the callback dest can never be in the first block
        (if (i32.eq (get_global $cb_dest) (i32.const 0)) 
          (then
            ${wasm}
          )
          (else 
            ;; return callback destination and zero out $cb_dest 
            (set_local $jump_map_switch (get_global $cb_dest))
            (set_global $cb_dest (i32.const 0))
            (br_table $0 ${brTable} (get_local $jump_map_switch))
          )))))`

  return wasm
}

// returns the index of the next jump destination opcode in given EVM code in an
// array and a starting index
// @param {Array} evmCode
// @param {Integer} index
// @return {Integer}
function findNextJumpDest (evmCode, i) {
  for (; i < evmCode.length; i++) {
    const opint = evmCode[i]
    const op = opcodes(opint)
    switch (op.name) {
      case 'PUSH':
        // skip add how many bytes where pushed
        i += op.number
        break
      case 'JUMPDEST':
        return --i
    }
  }
  return --i
}

// converts 8 bytes into a int 64
// @param {Integer}
// @return {String}
function bytes2int64 (bytes) {
  return new BN(bytes).fromTwos(64).toString()
}

// Ensure that dependencies are only imported once (use the Set)
// @param {Set} funcSet a set of wasm function that need to be linked to their dependencies
// @return {Set}
function resolveFunctionDeps (funcSet) {
  const funcs = new Set(funcSet)
  const queue = Array.from(funcs)

  for (let i = 0; i < queue.length; i++) {
    const func = queue[i]
    const deps = depMap.get(func)
    if (deps) {
      for (const dep of deps) {
        if (!funcs.has(dep)) {
          funcs.add(dep)
          queue.push(dep)
        }
      }
    }
  }
  return funcs
}

/**
 * given a Set of wasm function this return an array for wasm equivalents
 * @param {Set} funcSet
 * @return {Array}
 */
exports.resolveFunctions = function (funcSet, wastFiles) {
  let funcs = []
  let imports = []
  for (let func of resolveFunctionDeps(funcSet)) {
    funcs.push(wastFiles[func].wast)
    imports.push(wastFiles[func].imports)
  }
  return [funcs, imports]
}

/**
 * builds a wasm module
 * @param {Array} funcs the function to include in the module
 * @param {Array} imports the imports for the module's import table
 * @return {string}
 */
exports.buildModule = function (funcs, imports = [], callbacks = []) {
  let funcStr = ''
  for (let func of funcs) {
    funcStr += func
  }

  let callbackTableStr = ''
  if (callbacks.length) {
    callbackTableStr = `
    (table
      (export "callback") ;; name of table
        anyfunc
        (elem ${callbacks.join(' ')}) ;; elements will have indexes in order
      )`
  }

  return `
(module
  ${imports.join('\n')}
  (global $cb_dest (mut i32) (i32.const 0))
  (global $sp (mut i32) (i32.const -32))
  (global $init (mut i32) (i32.const 0))

  ;; memory related global
  (global $memstart i32  (i32.const 33832))
  ;; the number of 256 words stored in memory
  (global $wordCount (mut i64) (i64.const 0))
  ;; what was charged for the last memory allocation
  (global $prevMemCost (mut i64) (i64.const 0))

  ;; TODO: memory should only be 1, but can't resize right now
  (memory 500)
  (export "memory" (memory 0))

  ${callbackTableStr}

  ${funcStr}
)`
}

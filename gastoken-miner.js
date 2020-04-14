#!/usr/bin/env node
const axios        = require('axios')
const chalk        = require('chalk')
const program      = require('commander')
const fs           = require('fs')
const ethers       = require('ethers')
const Web3         = require('web3')
const _            = require('lodash')
const _cliProgress = require('cli-progress')

let config = require('./config.json')
let abi    = require('./gastoken.json')

const version = require('./package.json').version

const pipeline = async (funcs, bar) => {
  bar.start(funcs.length, 0)
  let counter = 0
  return await funcs.reduce((promise, func) => {
    return promise.then(result => {
      bar.update(++counter)
      return func().then(Array.prototype.concat.bind(result))
    })
  }, Promise.resolve([]))
}

function validateChain(chain) {
  let allChains = ['ETC', 'ETH', 'kovan']
  let valid = _.includes(allChains, chain)
  if (!valid) {
    console.error('Wrong chain', chain)
    process.exit(1)
  }
  return chain
}

function validateTokenType(std) {
  let allTypes = ['GST1', 'GST2']
  let valid = _.includes(allTypes, std)
  if (!valid) {
    console.error('Wrong token type', std)
    process.exit(1)
  }
  return std
}

function validateBatch(batch) {
  let parsedbatch = parseInt(batch)
  if (_.isNaN(parsedbatch)) {
    console.error('Batch size must be an integer, i.e. 10. You supplied', chalk.red(batch))
    process.exit(1)
  }
  return parsedbatch
}

function validateAmount(batch) {
  let parsedbatch = parseInt(batch)
  if (_.isNaN(parsedbatch)) {
    console.error('Amount must be an integer, i.e. 80. You supplied', chalk.red(batch))
    process.exit(1)
  }
  return parsedbatch
}

function getChainId(chain) {
  if (chain === 'ETC') { return 61 }
  if (chain === 'ETH') { return 1 }
  if (chain === 'kovan') { return 42 }
  console.log('Unknown chainId for chain', chain)
  process.exit(1)
}

async function getGasPrice(chain) {
  if (chain === 'ETC') { return 1000000 }
  let gasApiUrl = 'https://www.ethgasstationapi.com/api/low'
  return (await axios.get(gasApiUrl)).data * 1000000000
}

async function waitForTxToBeMined(hash, chain) {
  let web3 = new Web3(new Web3.providers.HttpProvider(config[chain].rpcnode))
  while (true) {
    try {
      const receipt = await web3.eth.getTransactionReceipt(hash)
      if (receipt.status) { break }
    } catch(e) {
      await sleep(1000)
    }
  }
  return true
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function confirmTransaction(hash) {
  if (program.chain === 'ETC') {
    await sleep(100)
    return true
  }
  if (program.chain === 'ETH') {
    await sleep(100)
    return true
  }
  if (program.chain === 'kovan') {
    await sleep(100)
    return true
  }
  console.error('Unknown chain ', program.chain)
  process.exit(1)
}


program
  .version(version, '-v, --version')
  .description('Miner for GasToken on both ETH and ETC chains. More details are available at ' + chalk.underline.green('https://forum.saturn.network/t/gastoken-tokenize-gas/2361'))
  .option('-c, --chain <chain>', 'The chain on which you want to mine', validateChain, 'ETC')
  .option('-t, --token <tokentype>', 'Must be either GST1 or GST2. Read more on ' + chalk.underline.green('https://gastoken.io'), validateTokenType, 'GST1')
  .option('-b, --batch <batchsize>', 'How many mining transactions to send in one batch', validateBatch, 10)
  .option('-a, --amount <amount>', 'How many tokens to mine per one call? ' + chalk.red('BE CAREFUL OF LARGE VALUES'), validateAmount, 80)
  .option('-p, --pkey [pkey]', 'Private key of the mining address. Do not need to supply this if you supply a mnemonic')
  .option('-m, --mnemonic [mnemonic]', 'Mnemonic (i.e. from Saturn Wallet) of the wallet with which you want to mine')
  .option('-n, --rpcnode [rpcnode]', 'Optional url to the JSONRPC node to be used for mining')
  .option('-g, --gasprice [gasprice]', 'Optional gas price (in wei) to be used for mining. Leave empty for automatic discovery')
  .parse(process.argv)

if (!program.mnemonic && !program.pkey) {
  console.error('At least one of [pkey], [mnemonic] must be supplied')
  process.exit(1)
}

if (program.mnemonic && program.pkey) {
  console.error('Only one of [pkey], [mnemonic] must be supplied')
  process.exit(1)
}

let rpcnode = program.rpcnode || config[program.chain].rpcnode
let chainId = getChainId(program.chain)
let provider = new ethers.providers.JsonRpcProvider(rpcnode, { chainId: chainId, name: program.chain })

let wallet
if (program.mnemonic) {
  wallet = ethers.Wallet.fromMnemonic(program.mnemonic).connect(provider)
} else {
  wallet = new ethers.Wallet(program.pkey, provider)
}

let token = new ethers.Contract(config[program.chain][program.token], abi, wallet)

let mineToken = async function(token, amount, nonce, gasPrice) {
  let tx = await token.mint(amount, { gasPrice: gasPrice, nonce: nonce })
  await confirmTransaction(tx.hash)
  return tx.hash
}

wallet.getTransactionCount().then(async (whatever) => {
  let gasPrice = parseInt(program.gasprice) || await getGasPrice(program.chain)
  console.log(chalk.black.bgWhite('Gastoken miner v'+version+' developed by Saturn Network'))

  while (true) {
    let nonce = await wallet.getTransactionCount()
    let balance = await token.balanceOf(wallet.address)
    console.log('💰  Current balance:', chalk.green(parseInt(balance.toString()) / 100), chalk.green(program.token))
    console.log(chalk.yellow('⛏   Mining a batch of size', program.batch, 'with gas price', gasPrice))
    let jobs = _.map(Array.from({length: program.batch}, (v, i) => i), function(offset) {
      return async () => await mineToken(token, program.amount, nonce + offset, gasPrice)
    })
    const bar = new _cliProgress.Bar({}, _cliProgress.Presets.shades_classic)
    let txs = await pipeline(jobs, bar).catch((err) => {
      bar.stop()
      console.error(chalk.red('Something went wrong! Please ask for help and provide this error message.'))
      console.error(err)
      process.exit(1)
    })
    bar.stop()
    console.log(chalk.yellow('⏱   Awaiting confirmation'))
    let confirmations = _.map(txs, function(hash) {
      return async () => await waitForTxToBeMined(hash, program.chain)
    })
    await pipeline(confirmations, bar).catch((err) => {
      bar.stop()
      console.error(chalk.red('Something went wrong! Please ask for help and provide this error message.'))
      console.error(err)
      process.exit(1)
    })
    bar.stop()
  }
})

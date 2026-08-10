#!/usr/bin/env node
import process from 'node:process'

import { runCli } from './cli'
import { createProductionPorts } from './runtime'
import { appIdentity } from './shared/app-identity'
import { createSignalController } from './signals'
const ports = createProductionPorts({ identity: appIdentity })
const signals = createSignalController(ports.session)
process.on('SIGINT', () => {
  void signals.handle('SIGINT')
})
process.on('SIGTERM', () => {
  void signals.handle('SIGTERM').then((code) => {
    process.exitCode = code
  })
})
process.on('SIGHUP', () => {
  void signals.handle('SIGHUP').then((code) => {
    process.exitCode = code
  })
})
const result = await runCli(process.argv.slice(2), ports)
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(`${result.stderr}\n`)
process.exitCode = result.exitCode

#!/usr/bin/env node
import process from 'node:process'
import { runCli } from './cli.js'
import { unavailablePorts } from './ports.js'
import { createSignalController } from './signals.js'
const ports = unavailablePorts()
const signals = createSignalController(ports.session)
process.on('SIGINT', () => { void signals.handle('SIGINT') })
process.on('SIGTERM', () => { void signals.handle('SIGTERM').then(code => { process.exitCode = code }) })
process.on('SIGHUP', () => { void signals.handle('SIGHUP').then(code => { process.exitCode = code }) })
const result = await runCli(process.argv.slice(2), ports)
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(`${result.stderr}\n`)
process.exitCode = result.exitCode

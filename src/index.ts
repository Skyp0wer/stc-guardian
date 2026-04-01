#!/usr/bin/env node

import { resolve } from 'path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createGuardianServer } from './server.js'

const projectDir = resolve(process.env.GUARDIAN_PROJECT_DIR ?? process.cwd())
const server = createGuardianServer(projectDir)
const transport = new StdioServerTransport()

await server.connect(transport)

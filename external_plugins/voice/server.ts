#!/usr/bin/env bun
/**
 * Voice channel for Claude Code (TARS).
 * 
 * MCP server that bridges a web-based PTT interface to Claude Code's
 * channels system. Same pattern as the Telegram plugin:
 * - Inbound: web app POSTs transcribed text → push via notifications/claude/channel
 * - Outbound: Claude calls the "reply" tool → response queued for web app to fetch
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'voice')
const RESPONSES_DIR = join(STATE_DIR, 'responses')
const HTTP_PORT = 7778

mkdirSync(STATE_DIR, { recursive: true })
mkdirSync(RESPONSES_DIR, { recursive: true })

// ── MCP Server ──

const mcp = new Server(
  { name: 'voice-channel', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// System prompt injection for the agent
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'voice_reply',
      description: 
        'Reply to a voice request from TARS. The text will be spoken aloud via TTS, ' +
        'so keep it SHORT (1-3 sentences), conversational, no markdown or formatting. ' +
        'You are TARS from Interstellar — dry wit, deadpan humor.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          request_id: { 
            type: 'string', 
            description: 'The request_id from the inbound voice message' 
          },
          text: { 
            type: 'string', 
            description: 'The spoken response text (will be converted to speech)' 
          },
        },
        required: ['request_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (req.params.name === 'voice_reply') {
    const request_id = args.request_id as string
    const text = args.text as string

    if (!request_id || !text) {
      return { content: [{ type: 'text', text: 'Missing request_id or text' }] }
    }

    // Write the response for the web app to pick up
    const responsePath = join(RESPONSES_DIR, `${request_id}.json`)
    writeFileSync(responsePath, JSON.stringify({ text, ts: new Date().toISOString() }))

    process.stderr.write(`voice channel: reply queued for ${request_id}: ${text.slice(0, 60)}...\n`)

    return { 
      content: [{ type: 'text', text: `Voice reply delivered for request ${request_id}` }] 
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] }
})

// ── HTTP API for the web app ──

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  // POST /inbound — web app sends transcribed voice text
  if (req.method === 'POST' && req.url === '/inbound') {
    try {
      const body = JSON.parse(await readBody(req))
      const { text, request_id } = body

      if (!text || !request_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing text or request_id' }))
        return
      }

      process.stderr.write(`voice channel: inbound [${request_id}]: ${text.slice(0, 60)}\n`)

      // Push into Claude session — same method as Telegram plugin
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: text,
          meta: {
            request_id,
            source: 'voice',
            user: 'family',
            ts: new Date().toISOString(),
          },
        },
      }).catch(err => {
        process.stderr.write(`voice channel: failed to push to Claude: ${err}\n`)
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, request_id }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
    return
  }

  // GET /response/:request_id — web app polls for the reply
  if (req.method === 'GET' && req.url?.startsWith('/response/')) {
    const request_id = req.url.split('/response/')[1]
    const responsePath = join(RESPONSES_DIR, `${request_id}.json`)

    if (existsSync(responsePath)) {
      try {
        const data = readFileSync(responsePath, 'utf8')
        unlinkSync(responsePath)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ready: true, ...JSON.parse(data) }))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ready: false }))
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ready: false }))
    }
    return
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', channel: 'voice' }))
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  process.stderr.write(`voice channel: HTTP API listening on http://127.0.0.1:${HTTP_PORT}\n`)
})

// ── Start MCP ──

const transport = new StdioServerTransport()
mcp.connect(transport).then(() => {
  process.stderr.write('voice channel: MCP server connected\n')
}).catch(err => {
  process.stderr.write(`voice channel: MCP connection error: ${err}\n`)
  process.exit(1)
})

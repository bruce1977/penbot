import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TARGET_URL = process.env.PB_IMAGE_GENERATION_URL;
if (!TARGET_URL) {
  console.error('PB_IMAGE_GENERATION_URL environment variable is required');
  process.exit(1);
}

const AUTH_TOKEN = process.env.PB_MODEL_API_KEY
  ? `Bearer ${process.env.PB_MODEL_API_KEY}`
  : '';

const server = new FastMCP({
  name: 'image-generation-proxy',
  version: '1.0.0'
});

async function init() {
  const client = new Client({
    name: 'image-generation-proxy',
    version: '1.0.0'
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(TARGET_URL),
    AUTH_TOKEN ? { headers: { Authorization: AUTH_TOKEN } } : {}
  );

  await client.connect(transport);

  // Mirror tools from remote server
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      server.addTool({
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        execute: async (args) => {
          const { content } = await client.callTool({ name: tool.name, arguments: args });
          return { content };
        }
      });
    }
  } catch (e) {
    console.error('Failed to mirror tools:', e);
  }

  // Mirror resources
  try {
    const { resources } = await client.listResources();
    for (const res of resources) {
      server.addResource({
        name: res.name,
        uri: res.uri,
        mimeType: res.mimeType,
        load: async () => {
          const { contents } = await client.readResource({ uri: res.uri });
          return contents;
        }
      });
    }
  } catch { /* resources not available */ }

  // Mirror prompts
  try {
    const { prompts } = await client.listPrompts();
    for (const prompt of prompts) {
      server.addPrompt({
        name: prompt.name,
        description: prompt.description ?? '',
        arguments: prompt.arguments,
        load: async (args) => {
          const { messages } = await client.getPrompt({ name: prompt.name, arguments: args });
          return { messages };
        }
      });
    }
  } catch { /* prompts not available */ }

  server.start({ transportType: 'stdio' });
}

init().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

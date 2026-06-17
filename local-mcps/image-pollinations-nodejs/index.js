import { FastMCP } from 'fastmcp';
import { z } from 'zod';

const POLLINATIONS_BASE = 'https://image.pollinations.ai';

const server = new FastMCP({
  name: 'pollinations',
  version: '1.0.0'
});

server.addTool({
  name: 'text_to_image',
  description: 'Generate an image from a text description using Pollinations.AI (free, no auth needed). Returns the image URL.',
  parameters: z.object({
    prompt: z.string().describe('Text description of the image to generate'),
    width: z.number().default(1024).describe('Image width in pixels'),
    height: z.number().default(1024).describe('Image height in pixels'),
    seed: z.number().optional().describe('Seed for reproducible results'),
    model: z.string().default('turbo').describe('Model to use (default: "turbo"). Options: turbo, flux, any Pollinations supported model')
  }),
  execute: async (args) => {
    const { prompt, width = 1024, height = 1024, seed, model = 'turbo' } = args;
    const encoded = encodeURIComponent(prompt);
    let url = `${POLLINATIONS_BASE}/prompt/${encoded}?width=${width}&height=${height}&model=${model}`;
    if (seed !== undefined) url += `&seed=${seed}`;

    return {
      content: [{
        type: 'text',
        text: url
      }]
    };
  }
});

server.start({ transportType: 'stdio' });

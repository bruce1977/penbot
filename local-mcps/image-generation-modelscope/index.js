import { FastMCP } from 'fastmcp';
import { z } from 'zod';

const API_KEY = process.env.PB_MODEL_API_KEY;
if (!API_KEY) {
  console.error('PB_MODEL_API_KEY environment variable is required');
  process.exit(1);
}

const API_BASE = 'https://api-inference.modelscope.cn';

const server = new FastMCP({
  name: 'image-generation-modelscope',
  version: '1.0.0'
});

async function apiRequest(endpoint, body, method = 'POST', extraHeaders = {}) {
  const url = new URL(endpoint, API_BASE);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-ModelScope-Async-Mode': 'true',
        'Accept': 'application/json',
        ...extraHeaders
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new Error(`Network error during ${method} ${endpoint}: ${err.message}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`Failed to parse response from ${method} ${endpoint}: ${err.message} (status ${res.status})`);
  }
  return { status: res.status, data };
}

async function pollTask(taskId, maxRetries = 30, interval = 5000) {
  for (let i = 0; i < maxRetries; i++) {
    const { status, data } = await apiRequest(`/v1/tasks/${taskId}`, null, 'GET', {
      'X-ModelScope-Task-Type': 'image_generation'
    });
    if (data) {
      if (data.task_status === 'SUCCEED') {
        if (Array.isArray(data.output_images) && data.output_images[0]) {
          return data.output_images[0];
        }
        throw new Error(`Task ${taskId} SUCCEED but no output_images found: ${JSON.stringify(data)}`);
      }
      if (data.task_status === 'FAILED') {
        const msg = (data.errors && data.errors.message) || JSON.stringify(data);
        throw new Error(`Task ${taskId} failed: ${msg}`);
      }
    }
    if (status !== 200) {
      await new Promise(r => setTimeout(r, interval));
      continue;
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Task ${taskId} timed out after ${maxRetries * interval}ms`);
}

server.addTool({
  name: 'text_to_image',
    description: 'Generate an image from a text description using ModelScope API. Recommended model: Tongyi-MAI/Z-Image-Turbo.',
  parameters: z.object({
    description: z.string().describe('Text description of the image to generate'),
    model: z.string().default('Tongyi-MAI/Z-Image-Turbo').describe('Model name'),
    negative_prompt: z.string().default('lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry'),
    size: z.string().default('1024x1024').describe('Image size (e.g. 1024x1024)'),
    seed: z.number().optional(),
    steps: z.number().optional(),
    guidance: z.number().optional()
  }),
  execute: async (args) => {
    try {
      const body = {
        model: args.model,
        prompt: args.description,
        size: args.size,
        parameters: {}
      };
      if (args.seed !== undefined) body.parameters.seed = args.seed;
      if (args.steps !== undefined) body.parameters.steps = args.steps;
      if (args.guidance !== undefined) body.parameters.guidance = args.guidance;
      if (args.negative_prompt) body.parameters.negative_prompt = args.negative_prompt;

      const { status, data } = await apiRequest('/v1/images/generations', body);
      if (status !== 200) throw new Error(`Submit failed: ${JSON.stringify(data)}`);

      const taskId = data.task_id;
      if (!taskId) throw new Error(`No task_id in submit response: ${JSON.stringify(data)}`);

      const imageUrl = await pollTask(taskId);

      return {
        content: [{ type: 'text', text: imageUrl }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `text_to_image error: ${err.message}` }],
        isError: true
      };
    }
  }
});

server.addTool({
  name: 'text_image_to_image',
    description: 'Generate an image from a text description and an input image using ModelScope API. Recommended model: Tongyi-MAI/Z-Image-Turbo.',
  parameters: z.object({
    description: z.string().describe('Description of the image to generate'),
    image_url: z.string().describe('URL of the input image'),
    model: z.string().default('Tongyi-MAI/Z-Image-Turbo').describe('Model name'),
    negative_prompt: z.string().default('lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry'),
    size: z.string().default('1024x1024').describe('Image size (e.g. 1024x1024)'),
    seed: z.number().optional(),
    steps: z.number().optional(),
    guidance: z.number().optional()
  }),
  execute: async (args) => {
    try {
      const body = {
        model: args.model,
        prompt: args.description,
        size: args.size,
        input: { image: args.image_url },
        parameters: {}
      };
      if (args.seed !== undefined) body.parameters.seed = args.seed;
      if (args.steps !== undefined) body.parameters.steps = args.steps;
      if (args.guidance !== undefined) body.parameters.guidance = args.guidance;
      if (args.negative_prompt) body.parameters.negative_prompt = args.negative_prompt;

      const { status, data } = await apiRequest('/v1/images/generations', body);
      if (status !== 200) throw new Error(`Submit failed: ${JSON.stringify(data)}`);

      const taskId = data.task_id;
      if (!taskId) throw new Error(`No task_id in submit response: ${JSON.stringify(data)}`);

      const imageUrl = await pollTask(taskId);

      return {
        content: [{ type: 'text', text: imageUrl }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `text_image_to_image error: ${err.message}` }],
        isError: true
      };
    }
  }
});

server.start({ transportType: 'stdio' });

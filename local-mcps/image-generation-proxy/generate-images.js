// Generate images using ModelScope API directly
import https from 'https';

const API_KEY = process.env.PB_MODEL_API_KEY;
const API_BASE = 'https://api-inference.modelscope.cn';

const IMAGE_PROMPTS = [
  {
    id: 'img1',
    desc: `[Style]: Flat design infographic, modern Chinese tech illustration style, vector art
[Subject]: Left side: abstract silhouette profile of a young male tech entrepreneur with glasses; Right side: an abstract geometric company logo composed of interconnected nodes and speech bubbles forming a "P" shape, gradient blue to orange
[Setting]: Clean minimal white background, subtle grid lines
[Composition]: Symmetrical split layout, left silhouette right logo, with a thin dividing line in the center
[Color palette]: Deep navy blue (#1a237e), vibrant orange (#ff6f00), clean white, light gray
[Lighting]: Flat lighting, clean vector style, no shadows
[Mood]: Professional, innovative, forward-looking
[Text]: Chinese text annotations "林俊旸" under left image, "卜拉格 PRAGMATICS" under right image
[Quality]: (masterpiece, high quality, clean vector illustration, 8k)`
  },
  {
    id: 'img2',
    desc: `[Style]: Flat design comparison infographic, modern Chinese tech illustration, data visualization style
[Subject]: Two side-by-side feature comparison cards. Left card "GLM-5.2" with Chinese labels: 编程能力↑, MMLU 90分, MATH 82分, HumanEval 83分, 中文理解93分, 全量开放✓, 下周开源. Right card "Kimi K2.7 Code" with Chinese labels: 代码能力↑, Token消耗↓30%, 万亿参数MoE, 百万级长上下文, 开源✓. Small icons next to each feature.
[Setting]: Clean white background with subtle tech grid pattern
[Composition]: Two equal columns, each containing a card with rounded corners, data points listed vertically
[Color palette]: Left: deep blue; Right: vibrant purple; Background: off-white
[Lighting]: Flat lighting, clean presentation style
[Mood]: Objective comparison, professional competitive analysis
[Text]: Chinese headings and data labels throughout
[Quality]: (masterpiece, high quality, clean infographic, 8k)`
  },
  {
    id: 'img3',
    desc: `[Style]: Flat design conceptual diagram, clean modern illustration, Chinese tech infographic style
[Subject]: Left side: an old-fashioned typewriter illustration with text "打字机" emitting one letter at a time, labeled "自回归 Autoregressive — 逐字生成". Right side: a modern printing press / printer illustration with text "印刷机" printing a full page at once, labeled "扩散 Diffusion — 整页并行生成". Below: speed comparison arrows showing "×4 速度提升".
[Setting]: Clean white technological background with faint circuit patterns
[Composition]: Two-column comparison layout with central "VS" separator, bottom section with benchmark comparison
[Color palette]: Left side warm orange/amber, right side cool blue/teal, white background
[Lighting]: Flat vector lighting, clean and clear
[Mood]: Educational, revolutionary comparison, clear contrast
[Text]: Chinese annotations explaining each paradigm
[Quality]: (masterpiece, high quality, clean infographic, 8k)`
  },
  {
    id: 'img4',
    desc: `[Style]: Flat design conceptual infographic, modern Chinese tech illustration with chart elements
[Subject]: A line chart showing the "Scaling Law" curve that starts steep but begins to plateau and crack in the middle, with question marks "?" and a "crack" visual effect. From the crack emerges a smaller brain-like node labeled "HRM-Text 类脑模型 — 千分之一数据 + 数百倍算力节省" with an upward arrow showing it outperforming the original curve. Label at top: "Scaling Law 面临挑战". Small icons: brain, data tokens, compute chip.
[Setting]: Clean dark blue background representing research depth
[Composition]: Chart dominates center, with annotation callouts around key inflection points
[Color palette]: Dark navy, bright cyan for scaling curve, warm amber for HRM-Text breakthrough
[Lighting]: Flat digital illustration style
[Mood]: Provocative, paradigm-shifting, academic breakthrough
[Text]: Chinese annotations on key data points
[Quality]: (masterpiece, high quality, clean data visualization, 8k)`
  },
  {
    id: 'img5',
    desc: `[Style]: Flat design landscape infographic, modern Chinese tech industry map style
[Subject]: A three-tier pyramid landscape showing Chinese LLM competitive landscape. Top tier "领跑者" with icons for 阿里千问, 智谱GLM, DeepSeek — labeled 开源生态, 日更迭代. Middle tier "突围者" with 字节豆包, 腾讯混元, 月之暗面Kimi — labeled C端体验, 多模态. Bottom tier "新势力" with 卜拉格, MiniMax — labeled 世界模型, 具身智能. Connection arrows show dynamics.
[Setting]: Clean gradient background deep blue to light blue
[Composition]: Hierarchical pyramid with three tiers, company icons and arrows
[Color palette]: Top: gold/amber; Middle: teal; Bottom: purple; Background: blue gradient
[Lighting]: Flat clean lighting
[Mood]: Strategic, comprehensive overview, competitive analysis
[Text]: Chinese labels for all companies
[Quality]: (masterpiece, high quality, clean competitive landscape map, 8k)`
  },
  {
    id: 'img6',
    desc: `[Style]: Flat design social media follow guide, modern mobile UI style, Chinese tech illustration
[Subject]: A clean mobile phone mockup silhouette at center, with a QR code pattern (abstract black and white squares) on the phone screen. Above: "关注我们" heading. Below: abstract WeChat-style chat bubble icon. Decorative floating elements: small stars and abstract tech circles.
[Setting]: Clean gradient background warm orange to coral pink
[Composition]: Centered phone mockup, text above and below, balanced symmetrical layout
[Color palette]: Warm orange to coral pink gradient, white phone, dark text
[Lighting]: Flat design, soft ambient glow
[Mood]: Friendly, inviting, action-oriented (follow/subscribe)
[Text]: "关注我们" heading, "扫码关注 获取更多AI前沿资讯" subtitle
[Quality]: (masterpiece, high quality, clean mobile UI illustration, 8k)`
  }
];

async function makeRequest(endpoint, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const data = JSON.stringify(body);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-ModelScope-Async-Mode': 'true',
        'Accept': 'application/json'
      }
    };
    
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => responseData += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, raw: responseData });
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function pollTask(taskId, maxRetries = 30, interval = 3000) {
  for (let i = 0; i < maxRetries; i++) {
    const result = await makeRequest(`/v1/tasks/${taskId}`, 'GET', {});
    if (result.status === 200 && result.data) {
      if (result.data.task_status === 'SUCCEED' && result.data.output?.results?.[0]?.url) {
        return result.data.output.results[0].url;
      }
      if (result.data.task_status === 'FAILED') {
        throw new Error(`Task ${taskId} failed: ${JSON.stringify(result.data)}`);
      }
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Task ${taskId} timed out after ${maxRetries * interval}ms`);
}

async function generateImage(promptInfo) {
  console.log(`[${promptInfo.id}] Generating image...`);
  
  // Submit task
  const submitResult = await makeRequest('/v1/images/generations', 'POST', {
    model: 'Qwen/Qwen-Image',
    prompt: promptInfo.desc,
    size: '1024x1024'
  });
  
  if (submitResult.status !== 200) {
    throw new Error(`Submit failed: ${JSON.stringify(submitResult)}`);
  }
  
  const taskId = submitResult.data.task_id;
  console.log(`[${promptInfo.id}] Task submitted: ${taskId}`);
  
  // Poll for result
  const imageUrl = await pollTask(taskId);
  console.log(`[${promptInfo.id}] Image URL: ${imageUrl}`);
  
  return { id: promptInfo.id, url: imageUrl };
}

async function main() {
  const results = [];
  
  for (const prompt of IMAGE_PROMPTS) {
    try {
      const result = await generateImage(prompt);
      results.push(result);
      console.log(`✅ ${result.id}: ${result.url}`);
    } catch (e) {
      console.error(`❌ ${prompt.id}: ${e.message}`);
    }
    // Wait between requests
    await new Promise(r => setTimeout(r, 2000));
  }
  
  // Output final results as JSON for consumption
  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);

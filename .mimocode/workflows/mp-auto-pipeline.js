export const meta = {
  name: "mp-auto-pipeline",
  description: "从公众号抓取文章 → 多视角主题评价 → 撰写 → 校对 → 插图 → 转 HTML 发送邮件"
};

export default async function workflow(args) {
  const configPath = args['config-path'];
  if (!configPath) {
    throw new Error('Missing required argument: config-path');
  }

  // 读取配置文件
  const configContent = await readFile(configPath);
  const config = JSON.parse(configContent);

  // 设置变量
  const profile = config.settings.name;
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
  const outputDir = join('output', profile, dateStr);
  const tempDataDir = join('.temp', profile, '~data');
  const tempScriptsDir = join('.temp', profile, '~scripts');
  const configRuntime = join(tempDataDir, 'config.json');

  // 确保目录存在
  await mkdir(outputDir, { recursive: true });
  await mkdir(tempDataDir, { recursive: true });
  await mkdir(tempScriptsDir, { recursive: true });

  // 复制配置文件到运行时位置
  await writeFile(configRuntime, JSON.stringify(config, null, 2));

  console.log(`Profile: ${profile}`);
  console.log(`Output directory: ${outputDir}`);
  console.log(`Config runtime: ${configRuntime}`);

  // 步骤 1：信息采集
  console.log('步骤 1: 信息采集');
  const gathererResult = await agent('gatherer', {
    prompt: `根据配置文件 ${configRuntime} 使用 wechat-mp-articles 技能抓取公众号文章，生成汇总报告和 AI 遴选主题。输出目录: ${outputDir}`,
    description: '信息采集'
  });

  // 步骤 2：主题评价
  console.log('步骤 2: 主题评价');
  const topics = await glob(join(outputDir, 'topic_*.md'));
  const commentatorTypes = [
    'commentator-value',
    'commentator-tech', 
    'commentator-public',
    'commentator-academic',
    'commentator-ethics'
  ];

  const commentaryData = {
    topics: []
  };

  for (const topicFile of topics) {
    const topicContent = await readFile(topicFile);
    const topicName = topicFile.split('/').pop().replace('.md', '').replace('topic_', '');
    
    const topicData = {
      name: topicName,
      commentators: []
    };

    for (const commentatorType of commentatorTypes) {
      const commentatorResult = await agent(commentatorType, {
        prompt: `请从您的专业角度评价以下主题：\n\n${topicContent}`,
        description: `评价主题: ${topicName}`
      });

      topicData.commentators.push({
        display_name: commentatorType.replace('commentator-', ''),
        overall: commentatorResult.overall || 0
      });
    }

    // 计算平均分
    const avgScore = topicData.commentators.reduce((sum, c) => sum + c.overall, 0) / topicData.commentators.length;
    topicData.avg_score = avgScore.toFixed(1);

    commentaryData.topics.push(topicData);
  }

  // 选择最佳主题
  const selectedTopic = commentaryData.topics.reduce((best, topic) => 
    parseFloat(topic.avg_score) > parseFloat(best.avg_score) ? topic : best
  );

  // 生成评价报告
  const commentaryReport = generateCommentaryReport(commentaryData, profile);
  await writeFile(join(outputDir, 'commentary.md'), commentaryReport);

  // 生成选中主题报告
  const selectedTopicReport = generateSelectedTopicReport(selectedTopic, profile, dateStr);
  await writeFile(join(outputDir, 'selected-topic.md'), selectedTopicReport);

  // 步骤 3：撰写文章
  console.log('步骤 3: 撰写文章');
  const writerResult = await agent('writer', {
    prompt: `根据选中的主题 ${selectedTopic.name}，结合已下载的文章，撰写公众号文章。在需要配图的位置插入 [图：图片说明] 标记。`,
    description: '撰写文章'
  });

  // 步骤 4：校对
  console.log('步骤 4: 校对');
  const proofreaderResult = await agent('proofreader', {
    prompt: `请对以下文章进行校对：\n\n${writerResult.article}`,
    description: '校对文章'
  });

  // 步骤 5：插图
  console.log('步骤 5: 插图');
  const illustratorResult = await agent('illustrator', {
    prompt: `请根据文章中的 [图：图片说明] 标记生成配图：\n\n${proofreaderResult.article}`,
    description: '生成配图'
  });

  // 步骤 6：发送邮件
  console.log('步骤 6: 发送邮件');
  const emailResult = await agent('writer', {
    prompt: `将最终文章转换为 HTML 并发送到邮箱 ${config.settings.email}，邮件标题格式为：${selectedTopic.name} - ${dateStr}`,
    description: '发送邮件'
  });

  console.log('MP自动化管线执行完成');
  return {
    success: true,
    outputDir,
    selectedTopic: selectedTopic.name
  };
}

function generateCommentaryReport(data, profile) {
  const timestamp = new Date().toISOString();
  let report = `# 主题评价报告\n\n> 生成时间：${timestamp} | 来源：${profile}\n\n`;
  
  if (data.topics.length === 0) {
    report += '（暂无主题数据）\n';
    return report;
  }

  for (const topic of data.topics) {
    report += `## ${topic.name}\n\n`;
    report += '| 评论员 | 综合评分 |\n|--------|----------|\n';
    
    for (const commentator of topic.commentators) {
      report += `| ${commentator.display_name} | ${commentator.overall} |\n`;
    }
    
    report += `| **平均** | **${topic.avg_score}** |\n\n`;
  }

  return report;
}

function generateSelectedTopicReport(topic, profile, dateStr) {
  const timestamp = new Date().toISOString();
  let report = `# 选中主题\n\n> 生成时间：${timestamp} | 来源：${profile}\n\n`;
  report += `## 主题\n\n**${topic.name}**\n\n`;
  report += `## 中选理由\n\n该主题在所有评价维度中获得最高平均分：${topic.avg_score}\n\n`;
  report += `## 相关文章\n\n| # | 公众号 | 标题 | 本地路径 |\n|---|--------|------|----------|\n`;
  report += `| 1 | 示例公众号 | 示例标题 | \`output/${profile}/${dateStr}/article.md\` |\n`;
  
  return report;
}

async function mkdir(path, options) {
  const { mkdir } = await import('fs/promises');
  return mkdir(path, options);
}
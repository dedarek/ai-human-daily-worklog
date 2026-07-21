import type { Activity, Secrets, Settings } from "./types.js";
import { spawn } from "node:child_process";

async function curlPost(url: string, headers: Record<string, string>, payload: object) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const args = ["-sS", "--max-time", "180", "-X", "POST", url, "-w", "\n%{http_code}", "--data-binary", "@-"];
    for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
    const child = spawn("/usr/bin/curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `curl exited ${code}`));
      const split = stdout.lastIndexOf("\n"); resolve({ status: Number(stdout.slice(split + 1)), text: stdout.slice(0, split) });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
async function fetchPost(url: string, headers: Record<string, string>, payload: object) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(240_000) });
  return { status: response.status, text: await response.text() };
}

async function callModel(prompt: string, settings: Settings, secrets: Secrets, maxTokens = 1800) {
  if (!secrets.llmApiKey) throw new Error("请先在设置中填写 LLM API Key。");
  const base = settings.llmBaseUrl.replace(/\/$/, "");
  const url = settings.llmProtocol === "anthropic" ? `${base}/v1/messages` : `${base}/chat/completions`;
  const headers: Record<string, string> = settings.llmProtocol === "anthropic"
    ? { "Content-Type": "application/json", "x-api-key": secrets.llmApiKey, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${secrets.llmApiKey}` };
  let response: { status: number; text: string } | undefined;
  let lastError: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const payload = { model: settings.llmModel, messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: maxTokens };
      response = settings.llmProtocol === "openai" ? await fetchPost(url, headers, payload) : await curlPost(url, headers, payload);
      break;
    }
    catch (error: any) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 3000));
    }
  }
  if (!response) throw new Error(`LLM 网络请求失败（已重试 3 次）：${lastError?.cause?.message ?? lastError?.message ?? String(lastError)}`);
  if (response.status < 200 || response.status >= 300) throw new Error(`LLM 请求失败：${response.status} ${response.text}`);
  const body: any = JSON.parse(response.text);
  return settings.llmProtocol === "anthropic"
    ? body.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") || "模型没有返回报告内容。"
    : body.choices?.[0]?.message?.content as string || "模型没有返回报告内容。";
}

export async function writeMeetingMinutes(title: string, startedAt: string, endedAt: string, transcript: string, settings: Settings, secrets: Secrets) {
  const cleanTranscript = transcript.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 80_000);
  if (!cleanTranscript) throw new Error("会议录音中没有识别到可用语音，无法生成纪要。");
  const prompt = `你是专业的会议纪要整理人员。仅依据下面的 Microsoft Teams 会议逐字稿生成中文会议纪要。

会议标题：${title}
开始时间：${startedAt}
结束时间：${endedAt}

要求：
1. 按讨论主题归并，不按说话顺序复述，不虚构参会人姓名、决定或待办。
2. 区分讨论意见、已经明确的结论和明确分配的行动项；无法确认负责人或期限时写“未明确”，不要猜测。
3. 忽略寒暄、口头语、识别噪声和重复内容。
4. 不提及录音、转写模型、AI、证据或留痕。
5. 只使用以下结构；禁止粗体、斜体、表格、代码、链接和 Markdown 行内标记：

# ${title}
## 会议信息
- 时间：${startedAt} 至 ${endedAt}
- 平台：Microsoft Teams
## 会议概览
## 讨论内容
### 真实讨论主题
## 关键结论与决策
## 待办事项

逐字稿：
${cleanTranscript}`;
  return (await callModel(prompt, settings, secrets, 1800)).trim();
}

export function sourceSummaryLine(activities: Activity[]) {
  return [...activities.reduce((map, item) => map.set(item.process, (map.get(item.process) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}: ${count} 条`).join("；");
}

export async function writeReport(date: string, activities: Activity[], settings: Settings, secrets: Secrets, verifiedFacts: string[] = []) {
  if (!secrets.llmApiKey) throw new Error("请先在设置中填写 LLM API Key。");
  const sourceSummary = sourceSummaryLine(activities);
  const seen = new Set<string>(); const groups = new Map<string, Activity[]>();
  for (const x of activities) {
    const key = `${x.process}|${x.message.slice(0, 160)}`;
    if (seen.has(key)) continue; seen.add(key);
    const group = groups.get(x.process) ?? []; group.push(x); groups.set(x.process, group);
  }
  const quota = new Map<string, number>([["Teams Meeting", 16], ["Copilot", 16], ["ZCode", 14], ["Claude Code", 14], ["Codex", 12], ["Terminal", 8]]);
  const selected: Activity[] = [];
  for (const [process, items] of groups) {
    if (quota.has(process)) {
      const limit = Math.min(quota.get(process)!, items.length);
      if (limit === items.length) selected.push(...items);
      else for (let i = 0; i < limit; i++) selected.push(items[Math.floor(i * (items.length - 1) / Math.max(1, limit - 1))]);
    } else {
      // 非 agent 应用：把不同窗口标题聚合成一行，保留浏览器调研等主题又不淹没核心证据。
      const titles = [...new Set(items.map(it => it.message.replace(/^前台窗口：/, "").trim()).filter(t => t && t !== "前台应用处于活跃状态"))].slice(0, 12);
      selected.push({ timestamp: items[0].timestamp, process, evidenceId: items[0].evidenceId, message: titles.length ? `使用 ${process}，涉及：${titles.join("；")}` : `${process} 处于活跃状态` });
    }
  }
  selected.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const width = (process: string) => process === "Teams Meeting" ? 1200 : (process === "Copilot" || process === "ZCode") ? 400 : quota.has(process) ? 200 : 500;
  const compact = selected.slice(0, 60).map(x => `${x.evidenceId} | ${x.timestamp} | ${x.process} | ${x.message.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, width(x.process))}`).join("\n");
  const context = `你是资深项目负责人，仅依据操作留痕撰写 ${date} 的工作日报。

共同规则：
1. 按项目与工作主题归并，不按时间、命令或工具调用写流水账。
2. Claude Code、Codex、终端只是采集来源，不是工作主体，不突出工具名称。
3. 只写证据能够支持的事实；不得虚构完成、归档、上线、指标、设计或结论。
4. 不写下一步计划、后续计划、留痕说明或数据完整性。也不要把本系统自身的动作当作工作成果，包括：生成/写入/覆盖日报、周报、月报或会议纪要、同步到飞书知识库、留痕采集等，这些一律不写入报告。
5. 不暴露密钥、个人信息、证据 ID、完整源码或模型对话。
6. 禁止粗体、斜体、代码、表格、链接以及 **、__、反引号等 Markdown 行内标记。
7. 写作规则不是工作证据，不得把规则本身写入日报。
8. 不得给出留痕中未出现的具体数字、比例、指标；无法从留痕直接确认的原因、鉴权细节或因果结论不要臆测。
9. 只写与本职工作相关的内容。与工作无关的个人事务一律不写入日报，包括：语言/外语学习、看剧看视频、娱乐、游戏、炒股与证券行情、购物、社交闲聊、私人财务、健身、新闻资讯浏览等。若某条留痕无法判断是否与工作相关，宁可略去，不要为凑内容而纳入。日常邮件、团队沟通、会议、行政/人事流程属于工作，可以保留。

来源统计：${sourceSummary || "无"}
系统验证事实：${verifiedFacts.join("；") || "无"}
操作留痕：
${compact || "当天没有采集到可用操作记录。"}`;
  const withoutSectionHeading = (text: string) => text.trim().replace(/^#{1,2}\s+[^\n]+\n+/, "");
  const overview = withoutSectionHeading(await callModel(`${context}\n\n只写“工作概览”的正文，不要输出标题。用一至两个自然段概括主要项目、核心工作和当天总体成果，约 250–400 个中文字符。`, settings, secrets, 420));
  const projects = withoutSectionHeading(await callModel(`${context}\n\n只写“项目进展与产出”的内容。每个真实项目以“### 项目名称”为标题，随后用连贯自然段写清目标、分析或实施过程、解决的问题与已确认结果。不要机械使用“背景：”“过程：”“状态：”标签。总计约 900–1400 个中文字符。`, settings, secrets, 850));
  const judgements = withoutSectionHeading(await callModel(`${context}\n\n只写“关键问题与判断”的正文，不要输出标题。仅归纳操作留痕能直接支撑的问题、原因判断与决策依据，避免重复项目进展；若留痕没有体现明确的问题、冲突或决策，只写一句“当天留痕未体现明确的关键问题或决策”，不要为凑内容而臆测原因、数据或结论。约 200–450 个中文字符。`, settings, secrets, 420));
  const status = withoutSectionHeading(await callModel(`${context}\n\n只写“当前状态”的正文，不要输出标题。用状态词（已完成、已验证、进行中、受阻、待确认）逐个项目概括截至当天 18:00 的状态，每个项目一句，不要重复“项目进展与产出”的过程描述；系统验证事实优先。约 150–300 个中文字符。`, settings, secrets, 320));
  return `# ${date} 工作日志\n\n## 工作概览\n\n${overview}\n\n## 项目进展与产出\n\n${projects}\n\n## 关键问题与判断\n\n${judgements}\n\n## 当前状态\n\n${status}`;
}

export async function writeSummaryReport(kind: "weekly" | "monthly", label: string, sourceReports: Array<{ date: string; content: string }>, settings: Settings, secrets: Secrets) {
  const reportName = kind === "weekly" ? "周报" : "月报";
  const sources = sourceReports.map(item => `\n===== ${item.date} =====\n${item.content.slice(0, 3500)}`).join("\n").slice(0, 50_000);
  const context = `你是资深项目负责人。请依据下方已经生成并核验过的工作日报，撰写 ${label} 的中文${reportName}。

写作要求：
1. 按项目与工作主题归并，不按日期逐日复述，不写操作流水账。
2. 提炼本周期的目标、推进过程、关键产出、重要判断、问题解决情况与期末状态；相同事项跨多日出现时合并为一条完整进展。
3. Claude Code、Codex、终端等只是信息来源，不是工作主体，不要突出工具名称或单设 AI 协作章节。
4. 只写来源日报能够支持的事实，不得虚构完成状态、指标、结论或计划。
5. 不输出“下一步计划”“后续计划”“留痕说明”“数据完整性”等章节。
6. 只使用标题、自然段和列表；禁止粗体、斜体、代码、表格、链接以及 **、__、反引号等 Markdown 行内标记。
7. 内容要有总结性和管理视角，避免机械重复日报原句。
8. 不得给出来源日报中未出现的具体数字、比例或指标；无法确认的原因或结论不要臆测。

来源日报：
${sources || "本周期没有可用日报。"}`;
  const withoutSectionHeading = (text: string) => text.trim().replace(/^#{1,2}\s+[^\n]+\n+/, "");
  const section = async (instruction: string, maxTokens: number) => {
    try { return await callModel(`${context}\n\n${instruction}`, settings, secrets, maxTokens); }
    catch { return callModel(`${context}\n\n${instruction}\n请改为高度精炼版本，控制在 450 个中文字符以内。`, settings, secrets, Math.min(maxTokens, 450)); }
  };
  const overview = withoutSectionHeading(await section("只写“本期概览”的正文，不输出标题。概括本期主要方向、投入重点和总体成果，约 300–500 个中文字符。", 500));
  const projects = withoutSectionHeading(await section("只写“项目进展与成果”的内容。按真实项目设置“### 项目名称”标题，合并跨日进展，写清目标、推进过程、关键成果和期末状态，总计约 1000–1600 个中文字符。", 900));
  const judgements = withoutSectionHeading(await section("只写“关键问题与判断”的正文，不输出标题。归纳本期重要问题、原因判断和决策依据，约 300–500 个中文字符。", 480));
  const status = withoutSectionHeading(await section("只写“本期状态”的正文，不输出标题。按项目准确总结本期结束时的状态，不写未来计划，约 250–400 个中文字符。", 400));
  return `# ${label} ${reportName}\n\n## 本期概览\n\n${overview}\n\n## 项目进展与成果\n\n${projects}\n\n## 关键问题与判断\n\n${judgements}\n\n## 本期状态\n\n${status}`;
}

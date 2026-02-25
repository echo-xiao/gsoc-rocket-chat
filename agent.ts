import { GoogleGenerativeAI } from "@google/generative-ai";
import { getSymbolDetails } from './tools.js';
import * as fs from 'fs';

const genAI = new GoogleGenerativeAI("YOUR_API_KEY");
const model = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview",
  tools: [{
    functionDeclarations: [{
      name: "get_symbol_details",
      description: "当看到 [GSOC-REDUCTION] 标记且需要分析具体逻辑时，调用此工具获取函数原文。",
      parameters: {
        type: "object",
        properties: {
          symbol_name: { type: "string" },
          mapping_file_path: { type: "string" }
        },
        required: ["symbol_name", "mapping_file_path"]
      }
    }]
  }]
});

async function runAnalysis(userQuery: string) {
  const skeleton = fs.readFileSync('./output/sendMessage.skeleton.ts', 'utf8');
  const chat = model.startChat({
    systemInstruction: "你是一个 Rocket.Chat 专家。先看骨架，有必要时再通过 get_symbol_details 获取详情。"
  });

  let result = await chat.sendMessage(`文件骨架：\n${skeleton}\n\n索引路径：./output/sendMessage.mapping.json\n\n问题：${userQuery}`);
  const call = result.response.functionCalls()?.[0];

  if (call) {
    console.log(`🤖 Agent 决定深入查看: ${call.args.symbol_name}`);
    const details = getSymbolDetails(call.args.symbol_name as string, call.args.mapping_file_path as string);
    result = await chat.sendMessage([{ functionResponse: { name: "get_symbol_details", response: { content: details } } }]);
  }

  console.log("分析结果：", result.response.text());
}

runAnalysis("分析 sendMessage 函数的权限校验逻辑。");
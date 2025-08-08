import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MessageContent } from "@langchain/core/messages";

function extractText(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => typeof c.text === "string")
      .map((c) => c.text)
      .join(" ")
      .trim();
  }
  return "";
}

// Define task type and store
type Task = {
  id: number;
  description: string;
  completed: boolean;
};
const tasks: Task[] = [];
let taskIdCounter = 1;

type Bindings = {
  GEMINI_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", logger());
app.use("*", cors());

const messageSchema = z.object({
  message: z.string().min(1),
});

// CORRECTED SYSTEM_TEMPLATE
const SYSTEM_TEMPLATE = `
You are a task assistant. Based on the user input, extract the user's intent.

Reply in the following JSON format only, no other text:
{{
  "action": "add" | "delete" | "complete" | "list",
  "task": "task description here" (optional),
  "id": task ID (optional)
}}

Only include "task" if the action is "add". Only include "id" for "delete" or "complete".
`;

app.post("/chat", async (c) => {
  const body = await c.req.json();
  const result = messageSchema.safeParse(body);
  if (!result.success) return c.json({ error: "Invalid input" }, 400);

  const userMessage = result.data.message;

  const model = new ChatGoogleGenerativeAI({
    apiKey: c.env.GEMINI_API_KEY,
    model: "gemini-1.5-flash",
  });

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", SYSTEM_TEMPLATE],
    ["user", "{input}"],
  ]);

  const chain = RunnableSequence.from([prompt, model]);
  const output = await chain.invoke({ input: userMessage });

  let parsed;
  try {
	// Clean up potential markdown code fences from the model's output
	const raw = extractText(output.content).trim().replace(/^```json\s*|```$/g, '');
	parsed = JSON.parse(raw);
  } catch (err) {
	console.error("Failed to parse Gemini response:", err);
	return c.json({ error: "Invalid JSON from Gemini", raw: extractText(output.content) }, 500);
  }
  
  const { action, task, id } = parsed;

  if (!["add", "delete", "complete", "list"].includes(action)) {
    return c.json({ error: "Unknown action", parsed });
  }

  if (action === "add") {
    if (!task || typeof task !== "string") {
      return c.json({ error: "Missing task description" });
    }
    const newTask: Task = {
      id: taskIdCounter++,
      description: task.trim(),
      completed: false,
    };
    tasks.push(newTask);
    return c.json({ success: true, task: newTask });
  }

  if (action === "list") {
    return c.json({ tasks });
  }

  if (!id || typeof id !== "number") {
    return c.json({ error: "Missing or invalid task ID" });
  }

  const target = tasks.find((t) => t.id === id);
  if (!target) return c.json({ error: "Task not found" });

  if (action === "complete") {
    target.completed = true;
    return c.json({ success: true, task: target });
  }

  if (action === "delete") {
    const index = tasks.findIndex((t) => t.id === id);
    tasks.splice(index, 1);
    return c.json({ success: true });
  }

  return c.json({ error: "Unhandled case", parsed });
});

export default app;
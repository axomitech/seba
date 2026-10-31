// Verifies the Groq configuration against the live API (needs GROQ_API_KEY; uses your quota).
//   GROQ_API_KEY=... GROQ_MODEL=llama-3.3-70b-versatile node scripts/check-groq.mjs
const key = process.env.GROQ_API_KEY;
const model = process.env.GROQ_MODEL;
const base = (process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
if (!key || !model) { console.error("GROQ_API_KEY and GROQ_MODEL are required"); process.exit(2); }
const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
let failed = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  " + d : ""}`); if (!ok) failed++; };

const models = await fetch(`${base}/models`, { headers: H });
check("API key accepted (GET /models)", models.ok, `HTTP ${models.status}`);
if (models.ok) {
  const ids = (await models.json()).data.map((m) => m.id);
  check(`model "${model}" is available to this key`, ids.includes(model), ids.includes(model) ? "" : `available: ${ids.slice(0, 12).join(", ")}`);
}
const chat = (body) => fetch(`${base}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model, max_completion_tokens: 200, ...body }) });

const plain = await chat({ messages: [{ role: "user", content: "Reply with the single word: ready" }] });
check("plain chat completion", plain.ok, `HTTP ${plain.status}`);

const tool = await chat({
  messages: [{ role: "user", content: "Search the textbooks for 'photosynthesis' using the tool." }],
  tools: [{ type: "function", function: { name: "search_textbook_content", description: "Search textbooks", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }],
  tool_choice: "auto",
});
const toolJson = tool.ok ? await tool.json() : null;
check("tool calling returns a tool_call", Boolean(toolJson?.choices?.[0]?.message?.tool_calls?.length), tool.ok ? "" : `HTTP ${tool.status}`);

const asm = await chat({ messages: [{ role: "user", content: "অসমীয়া ভাষাত এটা বাক্যত উত্তৰ দিয়া: পোহৰ কি?" }] });
const asmText = asm.ok ? (await asm.json()).choices[0].message.content : "";
check("Assamese reply contains Assamese script", /[ঀ-৿]/.test(asmText), asmText.slice(0, 80).replace(/\n/g, " "));
process.exit(failed ? 1 : 0);

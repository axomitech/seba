import { GroqError, type GroqMessage, type GroqService, type GroqToolSpec } from "./groq";
import { buildCitation, validateCitations, type SourceRef } from "./citations";
import { NO_EVIDENCE_MESSAGE, SYSTEM_PROMPT, buildUserPrompt, looksAssamese, type EvidenceBlock, type ResponseLanguage, type TutorTask } from "./prompts";

/** What the tutor needs from retrieval. Implemented by the Worker on top of PostgreSQL; the tutor never sees SQL. */
export interface Evidence extends Omit<SourceRef, "ref"> {
  text: string;
}

export interface RetrievalPort {
  search(query: string, limit: number): Promise<Evidence[]>;
  chapter(chapterId: string, maxChars: number): Promise<Evidence[]>;
}

export interface TutorRequest {
  question: string;
  task: TutorTask;
  language: ResponseLanguage;
  chapterId?: string;
}

export interface TutorResponse {
  answer: string;
  grounded: boolean;
  task: TutorTask;
  model: string | null;
  sources: Array<SourceRef & { citation: string }>;
  uncited_retrieved_sources: Array<SourceRef & { citation: string }>;
  dropped_citations: string[];
  tools_used?: string[];
}

const MAX_EVIDENCE_CHARS = 9000;
const MAX_PASSAGE_CHARS = 1800;

export function toRefs(evidence: Evidence[]): Array<{ ref: SourceRef; text: string }> {
  return evidence.map((e, i) => {
    const { text, ...meta } = e;
    return { ref: { ...meta, ref: `S${i + 1}` }, text };
  });
}

function cap(refs: ReturnType<typeof toRefs>) {
  const out: typeof refs = [];
  let total = 0;
  for (const r of refs) {
    const text = r.text.length > MAX_PASSAGE_CHARS ? r.text.slice(0, MAX_PASSAGE_CHARS) + " …" : r.text;
    if (total + text.length > MAX_EVIDENCE_CHARS && out.length) break;
    out.push({ ref: r.ref, text });
    total += text.length;
  }
  return out;
}

/** Deterministic "Sources" footer built from database metadata, never from model output. */
export function sourcesFooter(refs: SourceRef[], language: "english" | "assamese", related = false): string {
  if (!refs.length) return "";
  const head = language === "assamese" ? (related ? "সম্পৰ্কিত পাঠ্যপুথিৰ অংশ" : "উৎস") : (related ? "Related textbook passages" : "Sources");
  return `\n\n${head}:\n` + refs.map((r) => `[${r.ref}] ${buildCitation(r)}`).join("\n");
}

export class TutorService {
  constructor(
    private readonly groq: GroqService,
    private readonly retrieval: RetrievalPort,
    /** excerpt deployments: ask the model to paraphrase instead of reproducing textbook text */
    private readonly opts: { paraphraseOnly?: boolean } = {},
  ) {}

  private get system(): string {
    return this.opts.paraphraseOnly
      ? `${SYSTEM_PROMPT}\nParaphrase in your own words. Never quote more than one short sentence verbatim from a passage; point the learner to the cited source for the full text.`
      : SYSTEM_PROMPT;
  }

  async respond(req: TutorRequest): Promise<TutorResponse> {
    const lang: "english" | "assamese" =
      req.language === "assamese" || (req.language === "auto" && looksAssamese(req.question)) ? "assamese" : "english";
    const evidence = req.chapterId && req.task === "summarize_chapter"
      ? await this.retrieval.chapter(req.chapterId, MAX_EVIDENCE_CHARS)
      : await this.retrieval.search(req.question, 6);
    const refs = cap(toRefs(evidence));
    if (refs.length === 0) {
      return { answer: NO_EVIDENCE_MESSAGE[lang], grounded: false, task: req.task, model: null, sources: [], uncited_retrieved_sources: [], dropped_citations: [] };
    }
    const blocks: EvidenceBlock[] = refs.map((r) => ({ ref: r.ref.ref, label: buildCitation(r.ref), text: r.text }));
    const messages: GroqMessage[] = [
      { role: "system", content: this.system },
      { role: "user", content: buildUserPrompt(req.task, req.question, blocks, req.language) },
    ];
    const res = await this.groq.chat({ messages, maxTokens: req.task === "answer" ? 900 : 1500 });
    return this.finish(req.task, res.content, refs.map((r) => r.ref), res.model, lang);
  }

  /** Let the model decide which retrieval tools to call. Sources are collected from what was really returned. */
  async respondWithTools(
    req: TutorRequest,
    tools: GroqToolSpec[],
    exec: (name: string, args: unknown, register: (e: Evidence[]) => SourceRef[]) => Promise<unknown>,
  ): Promise<TutorResponse> {
    const lang: "english" | "assamese" =
      req.language === "assamese" || (req.language === "auto" && looksAssamese(req.question)) ? "assamese" : "english";
    const known: SourceRef[] = [];
    const register = (evs: Evidence[]) => {
      const added: SourceRef[] = [];
      for (const e of evs) {
        const same = known.find((k) => k.textbook_id === e.textbook_id && k.pdf_page_start === e.pdf_page_start && k.pdf_page_end === e.pdf_page_end && k.chapter_title === e.chapter_title);
        if (same) { added.push(same); continue; }
        const ref = { ...e, ref: `S${known.length + 1}` } as SourceRef & { text?: string };
        delete ref.text;
        known.push(ref);
        added.push(ref);
      }
      return added;
    };
    const system = `${this.system}\nYou can call tools to search and read the textbooks. Tool results label passages with handles like S1; cite those handles. Search before answering; if nothing relevant is found, say so.`;
    const messages: GroqMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `${req.task === "answer" ? "" : `Task: ${req.task}.\n`}${req.question}\n(${req.language === "auto" ? "Reply in the learner's language." : `Reply in ${req.language}.`})` },
    ];
    const out = await this.groq.runWithTools(messages, tools, (n, a) => exec(n, a, register));
    if (known.length === 0) {
      return { answer: NO_EVIDENCE_MESSAGE[lang], grounded: false, task: req.task, model: this.groq.model, sources: [], uncited_retrieved_sources: [], dropped_citations: [], tools_used: out.toolsUsed };
    }
    const r = this.finish(req.task, out.content, known, this.groq.model, lang);
    r.tools_used = out.toolsUsed;
    return r;
  }

  private finish(task: TutorTask, raw: string, refs: SourceRef[], model: string, lang: "english" | "assamese"): TutorResponse {
    const allowed = new Set(refs.map((r) => r.ref));
    const { valid, invalid, cleaned } = validateCitations(raw.trim(), allowed);
    const cited = refs.filter((r) => valid.includes(r.ref));
    const uncited = refs.filter((r) => !valid.includes(r.ref));
    const withCit = (r: SourceRef) => ({ ...r, citation: buildCitation(r) });
    const answer = cleaned + (cited.length ? sourcesFooter(cited, lang) : sourcesFooter(refs.slice(0, 3), lang, true));
    return {
      answer, grounded: cited.length > 0, task, model,
      sources: cited.map(withCit), uncited_retrieved_sources: uncited.map(withCit), dropped_citations: invalid,
    };
  }
}

export { GroqError };

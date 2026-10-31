import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const ROOT = join(__dirname, "..", "..", "..");
export const OWNER_DSN = process.env.TEST_DATABASE_URL;
export const READER_PASSWORD = "reader-test-password-123";
export const READER_ROLE = "seba_reader_vitest";   // roles are cluster-wide: never reuse the real role name in tests

export function readerDsn(): string {
  const u = new URL(OWNER_DSN!);
  u.username = READER_ROLE;
  u.password = READER_PASSWORD;
  return u.toString();
}

const ID = {
  s_sci_en: "10000000-0000-4000-8000-000000000001",
  s_sci_as: "10000000-0000-4000-8000-000000000002",
  s_shared: "10000000-0000-4000-8000-000000000003",
  s_rar: "10000000-0000-4000-8000-000000000004",
  s_pending: "10000000-0000-4000-8000-000000000005",
  t_sci_en: "20000000-0000-4000-8000-000000000001",
  t_sci_as: "20000000-0000-4000-8000-000000000002",
  t_reader_ix: "20000000-0000-4000-8000-000000000003",
  t_reader_x: "20000000-0000-4000-8000-000000000004",
  t_rar: "20000000-0000-4000-8000-000000000005",
  t_pending: "20000000-0000-4000-8000-000000000006",
  t_nolink: "20000000-0000-4000-8000-000000000007",
  t_removed: "20000000-0000-4000-8000-000000000008",
  ch_light: "30000000-0000-4000-8000-000000000001",
  ch_sound: "30000000-0000-4000-8000-000000000002",
  ch_as: "30000000-0000-4000-8000-000000000003",
};
export const IDS = ID;

export const EMBED_MODEL = "@cf/baai/bge-m3";

/** Deterministic 1024-d vectors: axis0 = light, axis1 = sound, axis2 = other. */
export function topicVector(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  const t = text.toLowerCase();
  v[0] = /light|reflection|পোহৰ/.test(t) ? 1 : 0;
  v[1] = /sound|vibrat|echo/.test(t) ? 1 : 0;
  v[2] = 0.05;
  return v;
}

export async function setupDatabase(): Promise<void> {
  const owner = new pg.Client({ connectionString: OWNER_DSN });
  await owner.connect();
  await owner.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const dir = join(ROOT, "database", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await owner.query(readFileSync(join(dir, f), "utf8"));
  for (const f of readdirSync(join(ROOT, "database", "seeders")).sort()) await owner.query(readFileSync(join(ROOT, "database", "seeders", f), "utf8"));

  const subj = async (key: string, name: string) =>
    (await owner.query("INSERT INTO subjects (name_key, name) VALUES ($1,$2) RETURNING id", [key, name])).rows[0].id as string;
  const science = await subj("general science", "General Science");
  const assamese = await subj("assamese", "Assamese");
  const lang = async (code: string) => (await owner.query("SELECT id FROM languages WHERE code=$1", [code])).rows[0].id as string;
  const [english, asm, all] = [await lang("english"), await lang("assamese"), await lang("all")];

  const src = (id: string, url: string, kind: string, status: string, pages: number | null) =>
    owner.query(
      `INSERT INTO textbook_sources (id,url,url_kind,status,ingest_stage,page_count,discovered_from,http_last_modified,local_path,sha256,extraction_summary)
       VALUES ($1,$2,$3,$4,$5,$6,'https://www.sebaonline.org/textbooks/textbooks.htm','Tue, 30 May 2023 08:51:39 GMT','/secret/local/path.pdf','deadbeef',$7)`,
      [id, url, kind, status, status === "indexed" ? "done" : "pending", pages, JSON.stringify({ pages_by_method: { text: pages }, chapter_quality: { method: "toc", status: "complete" } })]);
  await src(ID.s_sci_en, "https://www.sebaonline.org/textbooks/class-9/science_en.pdf", "pdf", "indexed", 5);
  await src(ID.s_sci_as, "https://www.sebaonline.org/textbooks/class-9/science_as.pdf", "pdf", "indexed", 2);
  await src(ID.s_shared, "https://www.sebaonline.org/textbooks/updated/reader_IX_X.pdf", "pdf", "indexed", 1);
  await src(ID.s_rar, "https://www.sebaonline.org/textbooks/newbooks/old.rar", "archive", "unsupported", null);
  await src(ID.s_pending, "https://www.sebaonline.org/textbooks/class-9/pending.pdf", "pdf", "discovered", null);

  const tb = (id: string, serial: number, title: string, cls: string, subject: string, language: string, label: string, type: string, source: string | null, status = "listed") =>
    owner.query(
      `INSERT INTO textbooks (id,catalogue_key,catalogue_serial,title,class_label,grade_min,grade_max,subject_id,language_id,medium_label,subject_type,source_id,catalogue_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, `key-${id}`, serial, title, cls, cls === "X" ? 10 : 9, cls === "IX" ? 9 : 10, subject, language, label, type, source, status]);
  await tb(ID.t_sci_en, 1, "Science Textbook", "IX", science, english, "English", "Core", ID.s_sci_en);
  await tb(ID.t_sci_as, 2, "Bigyan", "IX", science, asm, "Assamese", "Core", ID.s_sci_as);
  await tb(ID.t_reader_ix, 3, "Rapid Reader", "IX", assamese, all, "All", "MIL", ID.s_shared);
  await tb(ID.t_reader_x, 4, "Rapid Reader", "X", assamese, all, "All", "MIL", ID.s_shared);
  await tb(ID.t_rar, 5, "Old Fine Arts", "IX-X", assamese, asm, "Assamese", "Elective", ID.s_rar);
  await tb(ID.t_pending, 6, "Pending Physics", "X", science, english, "English", "Core", ID.s_pending);
  await tb(ID.t_nolink, 7, "No Link Book", "IX", science, english, "English", "Core", null);
  await tb(ID.t_removed, 8, "Removed Book", "IX", science, english, "English", "Core", ID.s_pending, "removed");

  const chapter = (id: string, source: string, ord: number, num: string | null, title: string, a: number, b: number, method = "toc") =>
    owner.query(`INSERT INTO chapters (id,source_id,ordinal,chapter_number,title,start_page,end_page,detection_method) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, source, ord, num, title, a, b, method]);
  await chapter(ID.ch_light, ID.s_sci_en, 1, "1", "Light", 1, 3);
  await chapter(ID.ch_sound, ID.s_sci_en, 2, "2", "Sound", 4, 5);
  await chapter(ID.ch_as, ID.s_sci_as, 1, "১", "পোহৰ", 1, 2, "heading");

  const pageText = [
    "Light travels in straight lines. A ray of light changes direction on reflection.",
    "The laws of reflection: the angle of incidence equals the angle of reflection. " + "Mirrors form images. ".repeat(40),
    "EXERCISE 1.1\n\n1. What is reflection of light?\n2. State the laws of reflection.\n(a) Draw a ray diagram.",
    "Sound is produced by vibrating bodies. An echo is reflected sound.",
    "Sound needs a medium to travel. It cannot travel through a vacuum.",
  ];
  for (const [i, text] of pageText.entries()) {
    await owner.query(
      `INSERT INTO textbook_pages (source_id,chapter_id,pdf_page_index,printed_page,content,char_count,extraction_method,ocr_confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ID.s_sci_en, i < 3 ? ID.ch_light : ID.ch_sound, i + 1, i === 0 ? null : String(i), text, text.length, i === 4 ? "ocr" : "text", i === 4 ? 91.4 : null]);
  }
  const asText = ["পোহৰ সৰল ৰেখাত গতি কৰে। প্ৰতিফলন পোহৰৰ ধৰ্ম।", "দৰ্পণত পোহৰৰ প্ৰতিফলন হয়।"];
  for (const [i, text] of asText.entries()) {
    await owner.query(`INSERT INTO textbook_pages (source_id,chapter_id,pdf_page_index,content,char_count,extraction_method) VALUES ($1,$2,$3,$4,$5,'ocr')`,
      [ID.s_sci_as, ID.ch_as, i + 1, text, text.length]);
  }
  await owner.query(`INSERT INTO textbook_pages (source_id,pdf_page_index,content,char_count,extraction_method) VALUES ($1,1,$2,$3,'text')`,
    [ID.s_shared, "A short story about a lamp and the light of knowledge.", 56]);

  const chunk = async (source: string, idx: number, chapter: string | null, a: number, b: number, kind: string, content: string) => {
    const id = (await owner.query(
      `INSERT INTO textbook_chunks (source_id,chapter_id,chunk_index,page_start,page_end,chunk_kind,content,token_estimate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [source, chapter, idx, a, b, kind, content, Math.ceil(content.length / 4)])).rows[0].id as string;
    await owner.query(`INSERT INTO textbook_embeddings (chunk_id,model,embedding) VALUES ($1,$2,$3::vector)`, [id, EMBED_MODEL, `[${topicVector(content).join(",")}]`]);
  };
  await chunk(ID.s_sci_en, 0, ID.ch_light, 1, 2, "body", pageText[0]! + "\n" + pageText[1]!);
  await chunk(ID.s_sci_en, 1, ID.ch_light, 3, 3, "exercise", pageText[2]!);
  await chunk(ID.s_sci_en, 2, ID.ch_sound, 4, 5, "body", pageText[3]! + "\n" + pageText[4]!);
  await chunk(ID.s_sci_as, 0, ID.ch_as, 1, 2, "body", asText.join("\n"));
  await chunk(ID.s_shared, 0, null, 1, 1, "body", "A short story about a lamp and the light of knowledge.");

  // least-privilege role used by the Worker under test
  const r = spawnSync("psql", [OWNER_DSN as string, "-v", "ON_ERROR_STOP=1", "-v", `reader_password=${READER_PASSWORD}`, "-v", `reader_role=${READER_ROLE}`, "-f", join(ROOT, "database", "roles", "create_reader.sql")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`reader role setup failed: ${r.stderr}`);
  await owner.end();
}

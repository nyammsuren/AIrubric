import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Load Canvas instances — supports both CANVAS_1_NAME and CANVAS1_NAME formats
const CANVAS_INSTANCES = [];
for (let i = 1; ; i++) {
  const name  = process.env[`CANVAS_${i}_NAME`]  || process.env[`CANVAS${i}_NAME`];
  const url   = (process.env[`CANVAS_${i}_URL`]  || process.env[`CANVAS${i}_URL`]  || "").replace(/\/$/, "");
  const token = process.env[`CANVAS_${i}_TOKEN`] || process.env[`CANVAS${i}_TOKEN`];
  if (!name && !url && !token) break;
  if (name && url && token) CANVAS_INSTANCES.push({ key: `canvas${i}`, name, url, token });
}

if (CANVAS_INSTANCES.length === 0) {
  console.warn("No Canvas instances configured. Set CANVAS_1_NAME, CANVAS_1_URL, CANVAS_1_TOKEN in .env");
}
if (!OPENAI_API_KEY) {
  console.warn("Missing OPENAI_API_KEY");
}

function getInstance(key) {
  if (!key) return CANVAS_INSTANCES[0] || null;
  return CANVAS_INSTANCES.find(c => c.key === key) || CANVAS_INSTANCES[0] || null;
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const DEFAULT_RUBRIC_MAP = {
  "C1.1": "CLO-ийн тодорхой байдал",
  "C1.2": "CLO ба агуулгын нийцэл",
  "C1.3": "CLO ба сургалтын үйл ажиллагаа",
  "C1.4": "CLO ба үнэлгээний нийцэл",
  "C2.1": "Шинжлэх ухааны үндэслэл",
  "C2.2": "Эх сурвалж",
  "C2.3": "Материалын боловсруулалт",
  "C2.4": "Бодит хэрэглээ",
  "C3.1": "Бүтэц, логик дараалал",
  "C3.2": "Танин мэдэхүйн ачаалал",
  "C3.3": "Дизайн",
  "C3.4": "Дотоод логик",
  "C4.1": "Танин мэдэхүйн оролцоо",
  "C4.2": "Нийгмийн оролцоо",
  "C4.3": "Багшийн оролцоо",
  "C4.4": "Хэлэлцүүлэг",
  "C5.1": "Явцын үнэлгээ",
  "C5.2": "Нээлттэй байдал",
  "C5.3": "Эргэх холбоо",
  "C5.4": "Өөрийн/чацуутны үнэлгээ",
  "C6.1": "Орчны бүтэц",
  "C6.2": "Дотоод зохион байгуулалт",
  "C6.3": "Технологийн интеграц",
  "C6.4": "Хүртээмж"
};

function buildRubricMap(clientRubric) {
  if (!Array.isArray(clientRubric) || clientRubric.length === 0) return DEFAULT_RUBRIC_MAP;
  const map = {};
  for (const criterion of clientRubric) {
    if (Array.isArray(criterion.indicators)) {
      for (const ind of criterion.indicators) {
        if (ind.id && ind.title) map[ind.id] = ind.title;
      }
    }
  }
  return Object.keys(map).length > 0 ? map : DEFAULT_RUBRIC_MAP;
}

function authHeaders(instance) {
  return {
    Authorization: `Bearer ${instance.token}`,
    "Content-Type": "application/json"
  };
}

async function canvasGet(instance, path, query = {}) {
  const url = new URL(`${instance.url}${path}`);
  Object.entries(query).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      v.forEach(item => url.searchParams.append(k, item));
    } else if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  const response = await fetch(url, { headers: authHeaders(instance) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Canvas API error ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, max = 18000) {
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max)}\n\n[TRUNCATED]`;
}

async function getCourseBundle(instance, courseId) {
  const [course, modules, assignments, discussions] = await Promise.all([
    canvasGet(instance, `/api/v1/courses/${courseId}`, { include: ["syllabus_body", "term"] }),
    canvasGet(instance, `/api/v1/courses/${courseId}/modules`, { per_page: 100, include: ["items"] }).catch(() => []),
    canvasGet(instance, `/api/v1/courses/${courseId}/assignments`, { per_page: 100 }).catch(() => []),
    canvasGet(instance, `/api/v1/courses/${courseId}/discussion_topics`, { per_page: 100 }).catch(() => [])
  ]);

  const pagesIndex = await canvasGet(instance, `/api/v1/courses/${courseId}/pages`, { per_page: 100 }).catch(() => []);
  const pages = [];
  for (const page of pagesIndex.slice(0, 20)) {
    try {
      const full = await canvasGet(instance, `/api/v1/courses/${courseId}/pages/${encodeURIComponent(page.url)}`);
      pages.push(full);
    } catch {
      // skip unreadable pages
    }
  }

  return { course, modules, assignments, discussions, pages };
}

function buildEvidenceText(bundle) {
  const coursePart = [
    `COURSE TITLE: ${bundle.course.name || ""}`,
    `COURSE CODE: ${bundle.course.course_code || ""}`,
    `SYLLABUS: ${stripHtml(bundle.course.syllabus_body || "")}`
  ].join("\n");

  const modulePart = bundle.modules.map((m, i) => {
    const items = Array.isArray(m.items) ? m.items.map(x => `- ${x.type}: ${x.title || x.page_url || x.content_id || ""}`).join("\n") : "";
    return `MODULE ${i + 1}: ${m.name || ""}\n${items}`;
  }).join("\n\n");

  const assignmentPart = bundle.assignments.map((a, i) => [
    `ASSIGNMENT ${i + 1}: ${a.name || ""}`,
    `POINTS: ${a.points_possible ?? ""}`,
    `DUE: ${a.due_at || ""}`,
    `DESCRIPTION: ${stripHtml(a.description || "")}`
  ].join("\n")).join("\n\n");

  const pagePart = bundle.pages.map((p, i) => [
    `PAGE ${i + 1}: ${p.title || p.url || ""}`,
    `BODY: ${stripHtml(p.body || "")}`
  ].join("\n")).join("\n\n");

  const discussionPart = bundle.discussions.map((d, i) => [
    `DISCUSSION ${i + 1}: ${d.title || ""}`,
    `MESSAGE: ${stripHtml(d.message || "")}`,
    `POINTS: ${d.points_possible ?? ""}`
  ].join("\n")).join("\n\n");

  return truncateText([
    coursePart,
    "=== MODULES ===",
    modulePart,
    "=== ASSIGNMENTS ===",
    assignmentPart,
    "=== PAGES ===",
    pagePart,
    "=== DISCUSSIONS ===",
    discussionPart
  ].join("\n\n"));
}

function validateAiScores(aiScores, rubricMap = DEFAULT_RUBRIC_MAP) {
  const result = {};
  for (const key of Object.keys(rubricMap)) {
    const raw = aiScores?.[key];
    const value = Number(raw);
    result[key] = Number.isNaN(value) ? 0 : Math.max(0, Math.min(3, Math.round(value)));
  }
  return result;
}

async function scoreWithAI(evidenceText, rubricMap = DEFAULT_RUBRIC_MAP) {
  const rubricList = Object.entries(rubricMap)
    .map(([id, title]) => `${id}: ${title}`)
    .join("\n");

  const prompt = `
Та бол онлайн хичээлийн чанарын үнэлгээний туслах шинжээч.

Доорх Canvas course-ийн өгөгдөл дээр үндэслэн дараах рубрикийн 24 дэд шалгуур бүрт 0-3 оноо санал болго.

Оноо бүрийн тайлбар:
0 = нотолгоо бараг байхгүй эсвэл хангалтгүй
1 = сул
2 = боломжийн
3 = хүчтэй нотолгоотой сайн хэрэгжсэн

ЧУХАЛ ДҮРЭМ:
- Зөвхөн өгөгдөлд байгаа нотолгоонд тулгуурла.
- Хэрэв мэдээлэл дутуу бол өндөр оноо бүү өг.
- C3, C4, C6.4 зэрэгт нотолгоо хангалтгүй бол 0 эсвэл 1 өг.
- Хариуг ЗӨВХӨН JSON хэлбэрээр буцаа.
- Markdown fence (\`\`\`) бүү ашигла.
- Тайлбар текст бүү нэм.
- Бүх property name-ээ "..." хэлбэрээр бич.
- Түлхүүрүүд нь яг C1.1 ... C6.4 байна.
- "overallAdvice" талбарт Монгол хэлээр 1-2 догол мөр нэгдсэн зөвлөмж өг.
- "evidenceSummary" талбарт хамгийн чухал 6 нотолгоог товч жагсаа.

Рубрик:
${rubricList}

Хариуны загвар:
{
  "aiScores": {
    "C1.1": 2,
    "C1.2": 1,
    "C1.3": 2,
    "C1.4": 2,
    "C2.1": 1,
    "C2.2": 1,
    "C2.3": 2,
    "C2.4": 2,
    "C3.1": 1,
    "C3.2": 0,
    "C3.3": 1,
    "C3.4": 1,
    "C4.1": 2,
    "C4.2": 2,
    "C4.3": 1,
    "C4.4": 0,
    "C5.1": 2,
    "C5.2": 2,
    "C5.3": 2,
    "C5.4": 2,
    "C6.1": 2,
    "C6.2": 2,
    "C6.3": 2,
    "C6.4": 1
  },
  "overallAdvice": "....",
  "evidenceSummary": ["....", "....", "...."]
}

Canvas өгөгдөл:
${evidenceText}
`;

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: prompt
  });

  let text = (response.output_text || "").trim();

  if (!text) {
    throw new Error("OpenAI хоосон хариу өглөө.");
  }

  // markdown code fence арилгана
  text = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

  // JSON объектын эхлэл, төгсгөлийг олж тасална
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("AI хариунаас JSON объект олдсонгүй.");
  }

  const jsonText = text.slice(firstBrace, lastBrace + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.error("AI raw text:\n", text);
    console.error("JSON candidate:\n", jsonText);
    throw new Error(`AI JSON parse алдаа: ${err.message}`);
  }

  return {
    aiScores: validateAiScores(parsed.aiScores, rubricMap),
    overallAdvice: String(parsed.overallAdvice || "").trim(),
    evidenceSummary: Array.isArray(parsed.evidenceSummary)
      ? parsed.evidenceSummary.map(String)
      : []
  };
}

app.get("/api/canvas/instances", (req, res) => {
  res.json({ ok: true, instances: CANVAS_INSTANCES.map(({ key, name }) => ({ key, name })) });
});

app.get("/api/canvas/courses", async (req, res) => {
  try {
    const instance = getInstance(req.query.instance);
    if (!instance) return res.status(400).json({ ok: false, message: "Canvas instance тохируулагдаагүй байна." });
    const data = await canvasGet(instance, "/api/v1/courses", {
      per_page: 50,
      enrollment_type: "teacher",
      search_term: req.query.search || ""
    });
    res.json({ ok: true, courses: data.map(c => ({ id: c.id, name: c.name, course_code: c.course_code })) });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/canvas/analyze-course", async (req, res) => {
  try {
    const { courseId, instanceKey, rubric } = req.body || {};
    if (!courseId) {
      return res.status(400).json({ ok: false, message: "courseId шаардлагатай." });
    }

    const instance = getInstance(instanceKey);
    if (!instance) {
      return res.status(400).json({ ok: false, message: "Canvas instance тохируулагдаагүй байна." });
    }

    const rubricMap = buildRubricMap(rubric);
    const bundle = await getCourseBundle(instance, courseId);
    const evidenceText = buildEvidenceText(bundle);
    const ai = await scoreWithAI(evidenceText, rubricMap);

    res.json({
      ok: true,
      courseId: bundle.course.id,
      courseTitle: bundle.course.name || bundle.course.course_code || "",
      aiScores: ai.aiScores,
      overallAdvice: ai.overallAdvice,
      evidenceSummary: ai.evidenceSummary,
      rawEvidencePreview: evidenceText.slice(0, 4000)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: error.message || "Unknown server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

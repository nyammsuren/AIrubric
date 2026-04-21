import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
const GOOGLE_SCRIPT_URL = (process.env.GOOGLE_SCRIPT_URL || "").replace(/\/$/, "");
const GOOGLE_SHEET_KEY = process.env.GOOGLE_SHEET_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

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
if (!ANTHROPIC_API_KEY) {
  console.warn("Missing ANTHROPIC_API_KEY");
}

function getInstance(key) {
  if (!key) return CANVAS_INSTANCES[0] || null;
  return CANVAS_INSTANCES.find(c => c.key === key) || CANVAS_INSTANCES[0] || null;
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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

  const discussionsWithEntries = await Promise.all(
    discussions.slice(0, 20).map(async d => {
      try {
        const entries = await canvasGet(instance, `/api/v1/courses/${courseId}/discussion_topics/${d.id}/entries`, { per_page: 100 });
        const participantIds = new Set(entries.map(e => e.user_id).filter(Boolean));
        return { ...d, entryCount: entries.length, participantCount: participantIds.size };
      } catch {
        return { ...d, entryCount: 0, participantCount: 0 };
      }
    })
  );

  return { course, modules, assignments, discussions: discussionsWithEntries, pages };
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
    `POINTS: ${d.points_possible ?? ""}`,
    `ENTRIES: ${d.entryCount ?? 0} (PARTICIPANTS: ${d.participantCount ?? 0})`
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
Та бол онлайн хичээлийн чанарын мэргэжлийн үнэлгээч. Canvas LMS-ийн өгөгдөлд үндэслэн 24 үзүүлэлт бүрт 0–3 оноо өг.

## ОНОО ӨГӨХ ШАЛГУУР

**3** — Тодорхой, олон нотолгоо байна. Системтэй, тогтмол хэрэгжсэн.
**2** — Нотолгоо байгаа ч бүрэн бус. 1-2 жишээ байна.
**1** — Ганц нэг нотолгоо байна. Хэрэгжилт хангалтгүй.
**0** — Нотолгоо байхгүй.

## ҮЗҮҮЛЭЛТ ТУСБҮРИЙН ЮУ ХАРАХ ВЭ

**C1.1** — Syllabus-т суралцагч юу чадах болохыг тодорхойлсон CLO байгаа эсэх; Bloom-ийн үйл үг (шинжлэх, үнэлэх гэх мэт) ашигласан эсэх
**C1.2** — Module нэрс, агуулгын гарчиг нь CLO-тэй уялдаж байгаа эсэх
**C1.3** — Assignment, discussion-ийн тайлбарт CLO-г дурдсан эсэх; даалгавар нь зорилготой холбогдсон эсэх
**C1.4** — Assignment-ийн оноо, тоо нь CLO тооцоотой тохирч байгаа эсэх
**C2.1** — Syllabus, page-д эрдэм шинжилгээний эх сурвалж, онол, загварыг дурдсан эсэх
**C2.2** — Assignment, page тайлбарт ном, нийтлэл, холбоос байгаа тоо
**C2.3** — Page-ийн агуулга зөвхөн жагсаалт биш, тайлбар, дүн шинжилгээ байгаа эсэх
**C2.4** — Assignment-д бодит байдлын сценари, кейс, практик даалгавар байгаа эсэх
**C3.1** — Module тоо (3-аас дээш), модуль бүрт item байгаа эсэх, дараалал логиктой эсэх
**C3.2** — Module бүрийн item тоо тэнцвэртэй эсэх (хэт олон буюу 15-аас дээш бол ачаалал өндөр)
**C3.3** — Page-д зураг, видео, жагсаалт зэрэг олон форматыг ашигласан эсэх
**C3.4** — Ижил module дотор assignment, page, discussion хоорондын логик уялдаа байгаа эсэх
**C4.1** — Assignment-д дүн шинжилгээ, нэгтгэл, бүтээлч ажил (зөвхөн test биш) байгаа эсэх
**C4.2** — Discussion-ийн оролцогчдын тоо (PARTICIPANTS талбар); 30%-иас дээш оролцоотой бол сайн
**C4.3** — Discussion тайлбарт багшийн зааварчилгаа, хариу өгөх амлалт байгаа эсэх
**C4.4** — Discussion тоо болон ENTRIES тоо; forum тус бүрийн идэвхийн түвшин
**C5.1** — Assignment тоо (5-аас дээш), due date хичээлийн туршид тархсан эсэх
**C5.2** — Rubric, оноо, шалгуур assignment тайлбарт тодорхой заасан эсэх
**C5.3** — Assignment тайлбарт feedback, коммент, хариу өгөх талаар дурдсан эсэх
**C5.4** — Assignment тайлбарт "peer review", "өөрийн үнэлгээ", "чацуутны үнэлгээ" гэж байгаа эсэх
**C6.1** — Module бүр нэртэй, item-үүд ангилагдсан, навигаци тодорхой эсэх
**C6.2** — Item нэрс тодорхой, дарааллын дугаар эсвэл логик нэршил байгаа эсэх
**C6.3** — Assignment, page-д гадаад хэрэгсэл, видео, интерактив контентыг нэгтгэсэн эсэх
**C6.4** — Page-ийн агуулгад альтернатив текст, хялбар хэл, хүртээмжийн тэмдэглэл байгаа эсэх

## ДҮРЭМ

- Зөвхөн CANVAS ӨГӨГДӨЛ хэсэгт байгаа нотолгоонд тулгуурла. Таамаглал бүү хий.
- Мэдээлэл байхгүй бол 0 өг — 2 эсвэл 3 өгөхийн тулд тодорхой нотолгоо шаардлагатай.
- "reasons" талбарт өгөгдөлд байгаа тодорхой зүйлийг (module нэр, assignment нэр, тоо гэх мэт) дурдан 1-2 өгүүлбэрээр Монголоор тайлбарла.
- "overallAdvice" талбарт: нийт дүгнэлт → хамгийн сул 3 үзүүлэлт → тус бүрд тодорхой, хийж болох алхам. Монголоор, практик байлга.
- "evidenceSummary" талбарт өгөгдөлд байгаа бодит тоо, нэрсийг жагсаа (модулийн тоо, даалгаврын тоо, хэлэлцүүлгийн оролцогчдын тоо гэх мэт).
- Хариуг ЗӨВХӨН JSON хэлбэрээр буцаа. Markdown fence (\`\`\`) бүү ашигла.

## РУБРИК
${rubricList}

## ХАРИУНЫ ФОРМАТ (утга бүрийг өгөгдөлд тулгуурлан бөглө)
{
  "aiScores": {
    "C1.1": <0-3>, "C1.2": <0-3>, "C1.3": <0-3>, "C1.4": <0-3>,
    "C2.1": <0-3>, "C2.2": <0-3>, "C2.3": <0-3>, "C2.4": <0-3>,
    "C3.1": <0-3>, "C3.2": <0-3>, "C3.3": <0-3>, "C3.4": <0-3>,
    "C4.1": <0-3>, "C4.2": <0-3>, "C4.3": <0-3>, "C4.4": <0-3>,
    "C5.1": <0-3>, "C5.2": <0-3>, "C5.3": <0-3>, "C5.4": <0-3>,
    "C6.1": <0-3>, "C6.2": <0-3>, "C6.3": <0-3>, "C6.4": <0-3>
  },
  "reasons": {
    "C1.1": "Энэ хичээлийн өгөгдөлд юу олдсон, юу дутуу байсан тухай тайлбар.",
    ...
  },
  "overallAdvice": "Нийт дүгнэлт ба хамгийн сул 3 үзүүлэлтийг сайжруулах тодорхой алхмууд.",
  "evidenceSummary": ["Өгөгдөлд байгаа бодит нотолгоо 1", "Нотолгоо 2", "Нотолгоо 3"]
}

## CANVAS ӨГӨГДӨЛ
${evidenceText}
`;

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    temperature: 0,
    messages: [{ role: "user", content: prompt }]
  });

  let text = (response.content?.[0]?.text || "").trim();

  if (!text) {
    throw new Error("Claude хоосон хариу өглөө.");
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
    reasons: (parsed.reasons && typeof parsed.reasons === "object") ? parsed.reasons : {},
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
      courseCode: bundle.course.course_code || "",
      courseTitle: bundle.course.name || bundle.course.course_code || "",
      aiScores: ai.aiScores,
      reasons: ai.reasons,
      overallAdvice: ai.overallAdvice,
      evidenceSummary: ai.evidenceSummary,
      rawEvidencePreview: evidenceText.slice(0, 4000)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: error.message || "Unknown server error" });
  }
});

// ===== ADMIN AUTH =====
const adminTokens = new Set();

app.get("/api/admin/verify", (req, res) => {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "").trim();
  res.json({ ok: adminTokens.has(token) });
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if ((password || "").trim() === ADMIN_PASSWORD.trim()) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    adminTokens.add(token);
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ ok: false, message: "Нууц үг буруу байна." });
  }
});

function requireAdmin(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "").trim();
  if (adminTokens.has(token)) return next();
  res.status(401).json({ ok: false, message: "Нэвтрэх шаардлагатай." });
}

// ===== EVALUATIONS STORE =====
const evaluations = [];

app.post("/api/evaluations", async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.courseCode) {
      return res.status(400).json({ ok: false, message: "Мэдээлэл дутуу байна." });
    }

    const entry = {
      id: Date.now(),
      courseCode: payload.courseCode,
      evaluator: payload.evaluator || "",
      evalDate: payload.evalDate || new Date().toISOString().split("T")[0],
      totalScore: payload.totalScore ?? 0,
      maxScore: payload.maxScore ?? 72,
      percent: payload.percent ?? 0,
      quality: payload.quality || "",
      overallAiAdvice: payload.overallAiAdvice || "",
      evidenceSummary: Array.isArray(payload.evidenceSummary) ? payload.evidenceSummary : [],
      criterionTotals: payload.criterionTotals || {},
      scores: payload.scores || {},
      submittedAt: new Date().toISOString()
    };

    evaluations.unshift(entry);
    if (evaluations.length > 200) evaluations.pop();

    // Google Sheets руу дамжуулах — SPSS-д тохирсон flat формат
    const googleUrl = process.env.GOOGLE_SCRIPT_URL;
    if (googleUrl) {
      try {
        const ct = payload.criterionTotals || {};
        const cp = payload.criterionPercents || {};
        const sc = payload.scores || {};

        const sheetPayload = {
          courseCode:      payload.courseCode || "",
          evaluator:       payload.evaluator || "",
          evalDate:        payload.evalDate || "",
          totalScore:      payload.totalScore ?? 0,
          maxScore:        payload.maxScore ?? 72,
          percent:         payload.percent ?? 0,
          quality:         payload.quality || "",
          overallAiAdvice: payload.overallAiAdvice || "",
          exportedAt:      payload.exportedAt || "",
          // Шалгуур тус бүрийн нийт оноо (C1–C6)
          C1_score: ct["C1.Шалгуур 1"] ?? "", C1_percent: cp["C1.Шалгуур 1"] ?? "",
          C2_score: ct["C2.Шалгуур 2"] ?? "", C2_percent: cp["C2.Шалгуур 2"] ?? "",
          C3_score: ct["C3.Шалгуур 3"] ?? "", C3_percent: cp["C3.Шалгуур 3"] ?? "",
          C4_score: ct["C4.Шалгуур 4"] ?? "", C4_percent: cp["C4.Шалгуур 4"] ?? "",
          C5_score: ct["C5.Шалгуур 5"] ?? "", C5_percent: cp["C5.Шалгуур 5"] ?? "",
          C6_score: ct["C6.Шалгуур 6"] ?? "", C6_percent: cp["C6.Шалгуур 6"] ?? "",
          // Үзүүлэлт тус бүрийн оноо (C1.1 – C6.4)
          "C1.1": sc["C1.1"] ?? "", "C1.2": sc["C1.2"] ?? "",
          "C1.3": sc["C1.3"] ?? "", "C1.4": sc["C1.4"] ?? "",
          "C2.1": sc["C2.1"] ?? "", "C2.2": sc["C2.2"] ?? "",
          "C2.3": sc["C2.3"] ?? "", "C2.4": sc["C2.4"] ?? "",
          "C3.1": sc["C3.1"] ?? "", "C3.2": sc["C3.2"] ?? "",
          "C3.3": sc["C3.3"] ?? "", "C3.4": sc["C3.4"] ?? "",
          "C4.1": sc["C4.1"] ?? "", "C4.2": sc["C4.2"] ?? "",
          "C4.3": sc["C4.3"] ?? "", "C4.4": sc["C4.4"] ?? "",
          "C5.1": sc["C5.1"] ?? "", "C5.2": sc["C5.2"] ?? "",
          "C5.3": sc["C5.3"] ?? "", "C5.4": sc["C5.4"] ?? "",
          "C6.1": sc["C6.1"] ?? "", "C6.2": sc["C6.2"] ?? "",
          "C6.3": sc["C6.3"] ?? "", "C6.4": sc["C6.4"] ?? ""
        };

        await fetch(googleUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(sheetPayload)
        });
      } catch (sheetErr) {
        console.error("Google Sheets алдаа:", sheetErr.message);
      }
    }

    res.json({ ok: true, id: entry.id });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/evaluations", requireAdmin, (req, res) => {
  res.json({ ok: true, evaluations });
});

app.get("/api/sheet-data", requireAdmin, async (req, res) => {
  try {
    if (!GOOGLE_SCRIPT_URL || !GOOGLE_SHEET_KEY) {
      return res.status(400).json({ ok: false, message: "Google Sheets тохируулагдаагүй." });
    }
    const url = `${GOOGLE_SCRIPT_URL}?key=${encodeURIComponent(GOOGLE_SHEET_KEY)}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status === "success") {
      res.json({ ok: true, data: data.data });
    } else {
      res.status(500).json({ ok: false, message: data.message || "Google Sheets алдаа." });
    }
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

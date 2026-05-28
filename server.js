import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { readFileSync } from "fs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
const GOOGLE_SCRIPT_URL = (process.env.GOOGLE_SCRIPT_URL || "").replace(/\/$/, "");
const GOOGLE_SHEET_KEY = process.env.GOOGLE_SHEET_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) {
  console.warn("Missing OPENAI_API_KEY");
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
      schoolName: payload.schoolName || "",
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
        const fb = payload.feedback || {};

        const sheetPayload = {
          id:              entry.id,
          courseCode:      payload.courseCode || "",
          schoolName:      payload.schoolName || "",
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
          "C6.3": sc["C6.3"] ?? "", "C6.4": sc["C6.4"] ?? "",
          // Feedback: тохирохгүй үзүүлэлтүүд
          fb_C1: fb["C1"] ?? "", fb_C2: fb["C2"] ?? "",
          fb_C3: fb["C3"] ?? "", fb_C4: fb["C4"] ?? "",
          fb_C5: fb["C5"] ?? "", fb_C6: fb["C6"] ?? "",
          fb_C1_all: fb["C1_all"] ? "тийм" : "", fb_C2_all: fb["C2_all"] ? "тийм" : "",
          fb_C3_all: fb["C3_all"] ? "тийм" : "", fb_C4_all: fb["C4_all"] ? "тийм" : "",
          fb_C5_all: fb["C5_all"] ? "тийм" : "", fb_C6_all: fb["C6_all"] ? "тийм" : "",
          sq_comment: payload.sq_comment || "",
          sq_exp:     payload.sq_exp || "",
          sq_use:     payload.sq_use || "",
          // Relevance: үзүүлэлт бүрийн хамааралын оноо
          ...Object.fromEntries(
            ["C1.1","C1.2","C1.3","C1.4","C2.1","C2.2","C2.3","C2.4",
             "C3.1","C3.2","C3.3","C3.4","C4.1","C4.2","C4.3","C4.4",
             "C5.1","C5.2","C5.3","C5.4","C6.1","C6.2","C6.3","C6.4"]
            .map(k => [`rel_${k.replace(".","_")}`, payload.relevance?.[k] ?? ""])
          )
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

app.post("/api/survey", async (req, res) => {
  try {
    const { evalId, schoolName, courseCode,
            survey_q1, survey_q2, survey_exp,
            survey_l1, survey_l2, survey_l3, survey_l4, survey_l5 } = req.body || {};

    const numericId = Number(evalId);
    const entry = evaluations.find(e => e.id === numericId);

    const surveyData = {
      survey_q1: survey_q1 || "", survey_q2: survey_q2 || "",
      survey_exp: survey_exp || "",
      survey_l1, survey_l2, survey_l3, survey_l4, survey_l5
    };
    if (entry) Object.assign(entry, surveyData);

    const googleUrl = process.env.GOOGLE_SCRIPT_URL;
    if (googleUrl) {
      try {
        await fetch(googleUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "survey",
            evalId: numericId,
            schoolName: schoolName || entry?.schoolName || "",
            courseCode: courseCode || entry?.courseCode || "",
            ...surveyData
          })
        });
      } catch (err) {
        console.error("[survey] Sheets алдаа:", err.message);
      }
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/api/evaluations", requireAdmin, (req, res) => {
  res.json({ ok: true, evaluations });
});

app.get("/api/rubric", requireAdmin, (req, res) => {
  try {
    const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
    const start = html.indexOf("let rubric = [");
    if (start === -1) return res.json({ ok: false, message: "Рубрик олдсонгүй" });
    // Find matching closing bracket
    let depth = 0, i = html.indexOf("[", start);
    const begin = i;
    while (i < html.length) {
      if (html[i] === "[") depth++;
      else if (html[i] === "]") { depth--; if (depth === 0) break; }
      i++;
    }
    const rubric = new Function("return " + html.slice(begin, i + 1))();
    res.json({ ok: true, rubric });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
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

app.post("/api/score-advice", async (req, res) => {
  try {
    const { scores, rubric: clientRubric } = req.body || {};
    if (!scores || typeof scores !== "object") {
      return res.status(400).json({ ok: false, message: "Оноо дутуу байна." });
    }
    const rubricMap = buildRubricMap(clientRubric);

    const totalScore = Object.values(scores).reduce((s, v) => s + Number(v || 0), 0);
    const percent = Math.round((totalScore / 72) * 100);

    const lines = Object.entries(rubricMap)
      .map(([id, title]) => `${id} (${title}): ${scores[id] ?? 0}/3`)
      .join("\n");

    const prompt = `Та онлайн хичээлийн чанарын мэргэжлийн үнэлгээч. Доорх үнэлгээний дүнг үндэслэн монголоор нэгдсэн дүгнэлт, зөвлөмж бич.

Нийт оноо: ${totalScore}/72 (${percent}%)

Үзүүлэлт бүрийн оноо (0=нотолгоо байхгүй, 1=хангалтгүй, 2=хангалттай, 3=маш сайн):
${lines}

Дараах бүтцээр хариул:

1. НИЙТ ДҮГНЭЛТ
Нийт оноо болон хичээлийн ерөнхий чанарын талаар 2 өгүүлбэр.

2. АНХААРАЛ ШААРДЛАГАТАЙ ҮЗҮҮЛЭЛТҮҮД
0 эсвэл 1 оноо авсан үзүүлэлт бүрт яг тухайн үзүүлэлтэд чиглэсэн тодорхой, хийж болохуйц 1-2 өгүүлбэрийн зөвлөмж өг.

3. ДАРААГИЙН АЛХАМ
Хичээлийг сайжруулахын тулд эхний ээлжид хийх 3 конкрет ажлыг нэрлэ.`;

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }]
    });

    const advice = (response.choices?.[0]?.message?.content || "").trim();
    res.json({ ok: true, advice });
  } catch (error) {
    console.error("[score-advice]", error);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/cvi-advice", requireAdmin, async (req, res) => {
  try {
    const { icvis, sAve, sUA, n, indicatorTitles } = req.body || {};
    if (!icvis) return res.status(400).json({ ok: false, message: "CVI өгөгдөл дутуу байна." });

    const lines = Object.entries(icvis)
      .map(([id, v]) => {
        const title = indicatorTitles?.[id] || id;
        const label = v === null ? "— (үнэлэгдээгүй)" : `${Number(v).toFixed(2)} ${v >= 0.78 ? "✓" : "✗"}`;
        return `${id} (${title}): ${label}`;
      }).join("\n");

    const fmtN = n ?? "?";
    const fmtAve = sAve != null ? Number(sAve).toFixed(2) : "—";
    const fmtUA  = sUA  != null ? Number(sUA).toFixed(2)  : "—";

    const prompt = `Та онлайн сургалтын рубрикийн агуулгын хүчинтэй байдлын (CVI) шинжээч юм. Дараах үр дүнг дүгнэн монголоор зөвлөмж өг.

Нийт эксперт: ${fmtN}
S-CVI/Ave: ${fmtAve}  (стандарт: ≥ 0.78 тохиромжтой, ≥ 0.90 маш сайн)
S-CVI/UA:  ${fmtUA}   (I-CVI = 1.00 байх үзүүлэлтийн хувь)

Үзүүлэлт тус бүрийн I-CVI (≥ 0.78 = ✓ тохиромжтой, < 0.78 = ✗ хянах шаардлагатай):
${lines}

Дараах бүтцээр хариул:

1. НИЙТ ДҮГНЭЛТ
Рубрикийн нийт CVI-ийн талаар 2–3 өгүүлбэрт үнэлэ.

2. АНХААРАЛ ШААРДЛАГАТАЙ ҮЗҮҮЛЭЛТҮҮД
I-CVI < 0.78 байгаа үзүүлэлт бүрт: яагаад экспертүүд тохирохгүй гэж үзсэн байж болох, яаж агуулга эсвэл томьёоллыг сайжруулах тухай тайлбарла.

3. РУБРИКИЙГ САЙЖРУУЛАХ ЗӨВЛӨМЖ
3–5 тодорхой, хийж болох алхмыг нэрлэ.`;

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }]
    });

    const advice = (response.choices?.[0]?.message?.content || "").trim();
    res.json({ ok: true, advice });
  } catch (error) {
    console.error("[cvi-advice]", error);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

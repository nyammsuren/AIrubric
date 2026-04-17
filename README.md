# Canvas AI Rubric Starter

Энэ төсөл нь Canvas course-ийн өгөгдлийг REST API-аар авч, AI-аар урьдчилан үнэлээд таны рубрикийн UI дээр автоматаар бөглөнө.

## Яаж ажиллах вэ
1. Canvas access token авна.
2. `.env.example` файлыг `.env` болгож хуулна.
3. `CANVAS_BASE_URL`, `CANVAS_ACCESS_TOKEN`, `OPENAI_API_KEY`-г бөглөнө.
4. `npm install`
5. `npm run dev`
6. `http://localhost:3000` нээнэ.
7. Canvas course ID оруулаад **Canvas-аас AI үнэлгээ** товч дарна.

## Анхаарах зүйл
- Одоогийн код нь course, modules, pages, assignments, discussions-ийг уншина.
- Submissions, SpeedGrader comments, rubric assessments зэргийг нэмж болно.
- AI 0-3 хооронд санал оноо өгнө. Эцсийн шийдвэрийг багш баталгаажуулна.
- `canvas.instructure.com` биш өөр Canvas домайн ашигладаг бол өөрийн сургуулийн домайныг `CANVAS_BASE_URL` дээр тавина.

## Дараагийн upgrade
- Course сонгох dropdown
- Assignment түвшний үнэлгээ
- Human vs AI agreement export
- LTI 1.3 launch

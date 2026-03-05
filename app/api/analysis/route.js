// app/api/analysis/route.js
// Análisis IA de la señal actual usando Claude

export const runtime = "edge";

export async function POST(req) {
  try {
    const body = await req.json();
    const { price, target, dist, window, decision } = body;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return Response.json({ text: "⚠ ANTHROPIC_API_KEY no configurada." }, { status: 200 });
    }

    const prompt = `Eres un analista experto en trading de criptomonedas y mercados de predicción (Polymarket).

Datos en tiempo real:
- BTC precio actual: $${price?.toFixed(2)}
- Target (open vela 1H): $${target?.toFixed(2)}
- Distancia al target: ${dist > 0 ? "+" : ""}$${dist?.toFixed(0)}
- Ventana activa: ${window || "Fuera de ventana de entrada"}
- Señal del bot: ${decision || "Sin señal activa"}

Proporciona un análisis conciso (2-3 frases máximo) que incluya:
1. Evaluación de la solidez de la señal
2. Riesgo estimado en este momento
3. Una observación técnica relevante

Responde directamente en español, sin títulos ni bullet points.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return Response.json({ text: `Error API: ${res.status}` }, { status: 200 });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "Análisis no disponible.";
    return Response.json({ text });
  } catch (e) {
    return Response.json({ text: "Error al obtener análisis." }, { status: 200 });
  }
}

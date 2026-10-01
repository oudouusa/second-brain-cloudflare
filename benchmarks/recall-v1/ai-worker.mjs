const ALLOWED_MODELS = new Set([
  "@cf/baai/bge-small-en-v1.5",
  "@cf/google/embeddinggemma-300m",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/embed") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!ALLOWED_MODELS.has(body?.model)) {
      return Response.json({ error: "unsupported_model" }, { status: 400 });
    }
    if (!Array.isArray(body?.texts) || body.texts.length < 1 || body.texts.length > 16
      || body.texts.some(text => typeof text !== "string" || text.length > 8000)) {
      return Response.json({ error: "invalid_texts" }, { status: 400 });
    }

    const result = await env.AI.run(body.model, { text: body.texts });
    return Response.json({ shape: result.shape, data: result.data });
  },
};

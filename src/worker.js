export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      return Response.json(
        {
          ok: true,
          platform: "cloudflare-workers",
          cloudSyncEnabled: Boolean(env.SURVEY_KV),
          timestamp: new Date().toISOString()
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    if (url.pathname === "/api/sync") {
      if (!env.SURVEY_KV) {
        return Response.json(
          {
            ok: false,
            cloudSyncEnabled: false,
            message: "SURVEY_KV binding not configured. Running in local offline mode."
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }

      const surveyKey = url.searchParams.get("room") || "vientiane_28_sites_default";

      if (request.method === "GET") {
        const stored = await env.SURVEY_KV.get(surveyKey, { type: "json" });
        return Response.json(
          { ok: true, cloudSyncEnabled: true, data: stored || null },
          { headers: { "Cache-Control": "no-store" } }
        );
      }

      if (request.method === "POST") {
        try {
          const incoming = await request.json();
          const existing = (await env.SURVEY_KV.get(surveyKey, { type: "json" })) || {};
          const merged = {
            completed: { ...(existing.completed || {}), ...(incoming.completed || {}) },
            notes: { ...(existing.notes || {}), ...(incoming.notes || {}) },
            specs: { ...(existing.specs || {}), ...(incoming.specs || {}) },
            capturedGps: { ...(existing.capturedGps || {}), ...(incoming.capturedGps || {}) },
            comments: mergeComments(existing.comments || {}, incoming.comments || {}),
            updatedAt: new Date().toISOString()
          };
          await env.SURVEY_KV.put(surveyKey, JSON.stringify(merged));
          return Response.json(
            { ok: true, cloudSyncEnabled: true, data: merged },
            { headers: { "Cache-Control": "no-store" } }
          );
        } catch (err) {
          return Response.json(
            { ok: false, error: err.message || "Invalid JSON payload" },
            { status: 400 }
          );
        }
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    return env.ASSETS.fetch(request);
  }
};

function mergeComments(existingMap, incomingMap) {
  const result = { ...existingMap };
  for (const [siteId, list] of Object.entries(incomingMap)) {
    const prev = Array.isArray(result[siteId]) ? result[siteId] : [];
    const seen = new Set(prev.map(c => c.id));
    const mergedList = [...prev];
    for (const item of Array.isArray(list) ? list : []) {
      if (item && item.id && !seen.has(item.id)) {
        seen.add(item.id);
        mergedList.push(item);
      }
    }
    result[siteId] = mergedList;
  }
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Health & KV binding check
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

    // 2. Shared survey state sync (checkmarks, technical specs, notes, comments, captured GPS, photo index)
    if (url.pathname === "/api/sync") {
      if (!env.SURVEY_KV) {
        return Response.json(
          {
            ok: false,
            cloudSyncEnabled: false,
            message: "SURVEY_KV binding not configured yet."
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }

      const surveyKey = "survey_state:vientiane_28_sites";

      if (request.method === "GET") {
        const stored = (await env.SURVEY_KV.get(surveyKey, { type: "json" })) || null;
        const photoList = await env.SURVEY_KV.list({ prefix: "photo:" });
        const photoKeys = photoList.keys.map(k => k.name);
        return Response.json(
          {
            ok: true,
            cloudSyncEnabled: true,
            data: stored,
            photoKeys
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }

      if (request.method === "POST") {
        try {
          const incoming = await request.json();
          const existing = (await env.SURVEY_KV.get(surveyKey, { type: "json" })) || {};

          const merged = {
            completed: mergeMapWithDeletes(existing.completed, incoming.completed),
            notes: mergeMapWithDeletes(existing.notes, incoming.notes),
            specs: mergeMapWithDeletes(existing.specs, incoming.specs),
            capturedGps: mergeMapWithDeletes(existing.capturedGps, incoming.capturedGps),
            comments: mergeComments(existing.comments || {}, incoming.comments || {}, incoming.deletedCommentIds || []),
            updatedAt: new Date().toISOString()
          };

          await env.SURVEY_KV.put(surveyKey, JSON.stringify(merged));
          const photoList = await env.SURVEY_KV.list({ prefix: "photo:" });
          const photoKeys = photoList.keys.map(k => k.name);

          return Response.json(
            {
              ok: true,
              cloudSyncEnabled: true,
              data: merged,
              photoKeys
            },
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

    // 3. Shared Photo Upload / Fetch / Delete (each photo stored as its own KV key: photo:<siteId>:<photoId>)
    if (url.pathname === "/api/photo") {
      if (!env.SURVEY_KV) {
        return Response.json({ ok: false, cloudSyncEnabled: false }, { status: 200 });
      }

      if (request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key || !key.startsWith("photo:")) {
          return Response.json({ ok: false, error: "Invalid photo key" }, { status: 400 });
        }
        const photoObj = await env.SURVEY_KV.get(key, { type: "json" });
        if (!photoObj) {
          return Response.json({ ok: false, error: "Photo not found" }, { status: 404 });
        }
        return Response.json(
          { ok: true, key, photo: photoObj },
          { headers: { "Cache-Control": "public, max-age=3600" } }
        );
      }

      if (request.method === "POST") {
        try {
          const body = await request.json();
          const { siteId, photo } = body;
          if (!siteId || !photo || !photo.id || !photo.dataUrl) {
            return Response.json({ ok: false, error: "Missing photo fields" }, { status: 400 });
          }
          const key = `photo:${siteId}:${photo.id}`;
          await env.SURVEY_KV.put(key, JSON.stringify({ ...photo, siteId: Number(siteId) }));
          return Response.json({ ok: true, key }, { headers: { "Cache-Control": "no-store" } });
        } catch (err) {
          return Response.json({ ok: false, error: err.message || "Failed to save photo" }, { status: 400 });
        }
      }

      if (request.method === "DELETE") {
        const key = url.searchParams.get("key");
        if (!key || !key.startsWith("photo:")) {
          return Response.json({ ok: false, error: "Invalid photo key" }, { status: 400 });
        }
        await env.SURVEY_KV.delete(key);
        return Response.json({ ok: true, deleted: key }, { headers: { "Cache-Control": "no-store" } });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    // 4. Static assets fallback
    return env.ASSETS.fetch(request);
  }
};

function mergeMapWithDeletes(existingObj, incomingObj) {
  const result = { ...(existingObj || {}) };
  if (!incomingObj || typeof incomingObj !== "object") return result;
  for (const [k, v] of Object.entries(incomingObj)) {
    if (v === null) {
      delete result[k];
    } else {
      result[k] = v;
    }
  }
  return result;
}

function mergeComments(existingMap, incomingMap, deletedIds) {
  const deletedSet = new Set(Array.isArray(deletedIds) ? deletedIds : []);
  const result = {};
  const allSiteIds = new Set([...Object.keys(existingMap || {}), ...Object.keys(incomingMap || {})]);

  for (const siteId of allSiteIds) {
    const prev = Array.isArray(existingMap[siteId]) ? existingMap[siteId] : [];
    const next = Array.isArray(incomingMap[siteId]) ? incomingMap[siteId] : [];
    const seen = new Set();
    const mergedList = [];

    for (const item of [...prev, ...next]) {
      if (item && item.id && !deletedSet.has(item.id) && !seen.has(item.id)) {
        seen.add(item.id);
        mergedList.push(item);
      }
    }
    if (mergedList.length > 0) {
      result[siteId] = mergedList;
    }
  }
  return result;
}
